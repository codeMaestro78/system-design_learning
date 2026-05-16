# Project 7: Scalable Notification System (Multi-Channel)

## Goal
Build a multi-channel notification system that:
- Sends notifications via Email, SMS, and Push (simulated providers)
- Respects user preferences (opt-out per channel, quiet hours)
- Deduplicates using idempotency keys (no double sends)
- Retries failed deliveries with exponential backoff
- Routes to Dead Letter Queue after max retries
- Tracks delivery status per notification

This project teaches: multi-channel fanout, idempotency, user preferences, provider abstraction, retry patterns.

---

## Architecture

```text
                         ┌──────────────────────────────────────────────┐
  Event                  │           Notification Service               │
  {"type": "order_placed"│                                              │
   "user_id": "u123"     │  ┌─────────────┐                            │
   "order_id": "o456"}   │  │ Dedup Engine │ <-- idempotency_key check  │
         │               │  └──────┬──────┘                            │
         v               │         │ (new event)                        │
  [Event Intake API]─────┼─────────┤                                    │
  POST /notify           │         v                                    │
                         │  ┌──────────────────┐                       │
                         │  │ Preference Engine │ <-- user opt-ins,     │
                         │  │                  │     quiet hours        │
                         │  └────────┬─────────┘                       │
                         │           │ (eligible channels)              │
                         │           v                                  │
                         │  ┌──────────────────┐                       │
                         │  │ Template Renderer │ <-- template_id,      │
                         │  │                  │     variables, locale  │
                         │  └────────┬─────────┘                       │
                         │           │ (rendered message)               │
                         │           v                                  │
                         │  ┌───────────────────────────────────────┐  │
                         │  │           Priority Queues             │  │
                         │  │  critical: [──────────────────────]   │  │
                         │  │  high:     [─────────────────]        │  │
                         │  │  normal:   [───────────────]          │  │
                         │  │  low:      [──────────]               │  │
                         │  └───────────────────────────────────────┘  │
                         │           │                                  │
                         │           v                                  │
                         │  ┌─────────────────────────────────────┐    │
                         │  │        Channel Workers              │    │
                         │  │  Email Worker  SMS Worker  Push     │    │
                         │  │       │             │        │      │    │
                         │  └───────┼─────────────┼────────┼──────┘    │
                         │         v             v        v             │
                         │  ┌──────────┐  ┌──────────┐  ┌────────┐    │
                         │  │ SendGrid │  │  Twilio  │  │  FCM   │    │
                         │  │(simulated│  │(simulated│  │(simul) │    │
                         │  └──────────┘  └──────────┘  └────────┘    │
                         │                                              │
                         │  ┌───────────────────────────────────────┐  │
                         │  │         Delivery Status Store         │  │
                         │  │  notification_id -> status, attempts  │  │
                         │  └───────────────────────────────────────┘  │
                         └──────────────────────────────────────────────┘
```

---

## Capacity Estimation

```python
# Notification system capacity for 10M DAU
dau = 10_000_000
notifs_per_user_per_day = 15   # order updates, promotions, reminders
total_daily = dau * notifs_per_user_per_day   # 150M/day

avg_qps = total_daily / 86400
peak_qps = avg_qps * 8          # 8x peak (flash sales, scheduled campaigns)

print(f"Average: {avg_qps:,.0f} notifs/sec")     # ~1,736/sec
print(f"Peak:    {peak_qps:,.0f} notifs/sec")    # ~13,889/sec

# Channel distribution (typical)
email_pct = 0.40
sms_pct   = 0.20
push_pct  = 0.40

email_peak = peak_qps * email_pct    # ~5,556/sec
sms_peak   = peak_qps * sms_pct     # ~2,778/sec
push_peak  = peak_qps * push_pct    # ~5,556/sec

print(f"\nPeak email: {email_peak:,.0f}/sec")
print(f"Peak SMS:   {sms_peak:,.0f}/sec")
print(f"Peak push:  {push_peak:,.0f}/sec")

# Storage for delivery records
bytes_per_record = 512        # notification_id + user_id + status + ts + payload
daily_storage_gb = total_daily * bytes_per_record / 1e9
print(f"\nDelivery records storage/day: {daily_storage_gb:.1f} GB")   # ~76.8 GB

# Idempotency store (keep 24h of keys)
idem_records_24h = total_daily
idem_storage_mb = idem_records_24h * 64 / 1e6  # 64 bytes per key
print(f"Idempotency store (24h): {idem_storage_mb:.0f} MB")    # ~9,600 MB ~= 9.4 GB Redis
```

---

## Full Working Implementation

```python
#!/usr/bin/env python3
"""
notification_system.py - Multi-channel notification system with preferences, dedup, retry.

Run:   uv run notification_system.py
Test:  curl -X POST http://localhost:8000/notify -d '{"event_type": "order_placed", ...}'
"""
# /// script
# dependencies = ["fastapi", "uvicorn"]
# ///

import asyncio
import json
import logging
import random
import re
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s"
)
logger = logging.getLogger(__name__)


# ============================================================================
# Enums and Constants
# ============================================================================

class Channel(str, Enum):
    EMAIL = "email"
    SMS   = "sms"
    PUSH  = "push"


class Priority(str, Enum):
    CRITICAL = "critical"   # OTP, password reset, security alerts
    HIGH     = "high"       # Order updates, payment confirmations
    NORMAL   = "normal"     # General updates, app notifications
    LOW      = "low"        # Marketing, promotions

    @property
    def bypasses_quiet_hours(self) -> bool:
        return self == Priority.CRITICAL


class DeliveryStatus(str, Enum):
    PENDING   = "pending"
    SENDING   = "sending"
    DELIVERED = "delivered"
    FAILED    = "failed"
    DEAD      = "dead"        # Moved to DLQ after max retries
    SUPPRESSED = "suppressed" # Blocked by preferences/quiet hours


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class Notification:
    id: str
    user_id: str
    event_type: str
    channel: Channel
    template_id: str
    variables: dict
    priority: Priority
    status: DeliveryStatus = DeliveryStatus.PENDING
    attempt_count: int = 0
    max_attempts: int = 5
    idempotency_key: Optional[str] = None
    locale: str = "en"
    created_at: float = field(default_factory=time.time)
    next_retry_at: float = field(default_factory=time.time)
    last_error: Optional[str] = None


@dataclass
class DeliveryRecord:
    notification_id: str
    channel: Channel
    status: DeliveryStatus
    attempt: int
    timestamp: float
    error: Optional[str] = None
    provider_id: Optional[str] = None  # Provider's message ID (for tracking)


# ============================================================================
# Template Engine
# ============================================================================

# Template registry: (template_id, channel, locale) -> template string
TEMPLATES = {
    ("order_placed", Channel.EMAIL, "en"): {
        "subject": "Order #{order_id} confirmed!",
        "body": "Hi {name},\n\nYour order #{order_id} for {amount} has been confirmed.\nEstimated delivery: {delivery_date}\n\nThank you!"
    },
    ("order_placed", Channel.SMS, "en"): {
        "body": "Hi {name}! Order #{order_id} confirmed. Delivery: {delivery_date}. Reply STOP to unsubscribe."
    },
    ("order_placed", Channel.PUSH, "en"): {
        "title": "Order Confirmed!",
        "body": "Order #{order_id} is on its way. Estimated: {delivery_date}"
    },
    ("password_reset", Channel.EMAIL, "en"): {
        "subject": "Reset your password",
        "body": "Hi {name},\n\nClick here to reset your password: {reset_link}\n\nThis link expires in 15 minutes."
    },
    ("password_reset", Channel.SMS, "en"): {
        "body": "Your {app_name} password reset code: {otp_code}. Valid for 15 minutes. Never share this code."
    },
    ("promo_weekly", Channel.EMAIL, "en"): {
        "subject": "🎉 Your weekly deals are here, {name}!",
        "body": "Check out this week's top deals curated just for you. Use code {promo_code} for {discount_pct}% off!"
    },
    ("promo_weekly", Channel.PUSH, "en"): {
        "title": "Weekly deals for you!",
        "body": "Deals you'll love. Use {promo_code} for {discount_pct}% off!"
    },
}


class TemplateEngine:
    """
    Renders notification templates by substituting variables.
    Supports per-channel, per-locale templates.
    """
    
    def render(self, template_id: str, channel: Channel, variables: dict,
               locale: str = "en") -> dict:
        key = (template_id, channel, locale)
        template = TEMPLATES.get(key)
        
        if not template:
            # Fallback to English
            key = (template_id, channel, "en")
            template = TEMPLATES.get(key)
        
        if not template:
            raise ValueError(f"No template found: {template_id}/{channel.value}/{locale}")
        
        rendered = {}
        for field, text in template.items():
            try:
                rendered[field] = text.format(**variables)
            except KeyError as e:
                raise ValueError(f"Missing template variable {e} for {template_id}")
        
        return rendered


# ============================================================================
# User Preferences
# ============================================================================

@dataclass
class UserPreference:
    user_id: str
    channels: dict = field(default_factory=lambda: {
        Channel.EMAIL: True,
        Channel.SMS:   True,
        Channel.PUSH:  True,
    })
    # Per event type, per channel opt-ins
    event_channels: dict = field(default_factory=dict)
    quiet_hours_start: int = 22    # 10pm local time
    quiet_hours_end: int = 8       # 8am local time
    timezone: str = "UTC"
    email: Optional[str] = None
    phone: Optional[str] = None
    device_token: Optional[str] = None


class PreferenceEngine:
    """
    Evaluates whether a notification should be sent to a given user on a given channel.
    
    Rules (in order of precedence):
    1. CRITICAL priority bypasses ALL quiet hours
    2. User has unsubscribed from channel globally -> suppress
    3. User has unsubscribed from this event type on this channel -> suppress
    4. Quiet hours active for non-critical -> delay (re-enqueue for later)
    5. User has no contact info for channel (no email/phone/device_token) -> suppress
    """
    
    def __init__(self):
        self._prefs: dict[str, UserPreference] = {}
    
    def get_or_create(self, user_id: str) -> UserPreference:
        if user_id not in self._prefs:
            self._prefs[user_id] = UserPreference(user_id=user_id)
        return self._prefs[user_id]
    
    def set_preference(self, user_id: str, pref: UserPreference) -> None:
        self._prefs[user_id] = pref
    
    def is_eligible(self, user_id: str, channel: Channel,
                    event_type: str, priority: Priority) -> tuple[bool, str]:
        """Returns (eligible, reason)."""
        pref = self._prefs.get(user_id)
        if pref is None:
            return True, "no_preferences"
        
        # Global channel opt-out
        if not pref.channels.get(channel, True):
            return False, f"user_opted_out_of_{channel.value}"
        
        # Per event-type channel opt-out
        event_key = f"{event_type}:{channel.value}"
        if pref.event_channels.get(event_key) is False:
            return False, f"user_opted_out_of_{event_type}_on_{channel.value}"
        
        # Missing contact info
        if channel == Channel.EMAIL and not pref.email:
            return False, "no_email_address"
        if channel == Channel.SMS and not pref.phone:
            return False, "no_phone_number"
        if channel == Channel.PUSH and not pref.device_token:
            return False, "no_device_token"
        
        # Quiet hours (only for non-critical)
        if not priority.bypasses_quiet_hours:
            tz = ZoneInfo(pref.timezone)
            now_local = datetime.now(tz)
            hour = now_local.hour
            
            start = pref.quiet_hours_start
            end = pref.quiet_hours_end
            
            in_quiet_hours = (
                (start > end and (hour >= start or hour < end)) or  # wraps midnight
                (start < end and start <= hour < end)
            )
            
            if in_quiet_hours:
                return False, "quiet_hours"
        
        return True, "eligible"
    
    def get_contact(self, user_id: str, channel: Channel) -> Optional[str]:
        pref = self._prefs.get(user_id)
        if pref is None:
            return f"fake_{channel.value}_{user_id}@example.com"  # Default for demo
        if channel == Channel.EMAIL:
            return pref.email
        if channel == Channel.SMS:
            return pref.phone
        if channel == Channel.PUSH:
            return pref.device_token
        return None


# ============================================================================
# Provider Simulators
# ============================================================================

class EmailProvider:
    """Simulates SendGrid / AWS SES email sending."""
    
    FAILURE_RATE = 0.05  # 5% failure rate
    
    async def send(self, to: str, subject: str, body: str) -> str:
        """Send email. Returns provider message ID."""
        await asyncio.sleep(0.05)  # Network latency
        
        if random.random() < self.FAILURE_RATE:
            raise ConnectionError(f"SendGrid API error: 503 Service Unavailable")
        
        msg_id = f"sg_{uuid.uuid4().hex[:12]}"
        logger.info(f"[EMAIL] to={to} subject='{subject[:30]}' msg_id={msg_id}")
        return msg_id


class SMSProvider:
    """Simulates Twilio SMS sending."""
    
    FAILURE_RATE = 0.08  # 8% failure rate (SMS more unreliable)
    
    async def send(self, to: str, body: str) -> str:
        await asyncio.sleep(0.10)  # Slightly slower
        
        if random.random() < self.FAILURE_RATE:
            raise ConnectionError("Twilio error: Unable to create record")
        
        msg_id = f"SM{uuid.uuid4().hex[:32]}"
        logger.info(f"[SMS] to={to} body='{body[:40]}...' msg_id={msg_id}")
        return msg_id


class PushProvider:
    """Simulates Firebase Cloud Messaging (FCM) push notification."""
    
    FAILURE_RATE = 0.03  # 3% failure rate
    
    async def send(self, device_token: str, title: str, body: str) -> str:
        await asyncio.sleep(0.02)  # Push is fastest
        
        if random.random() < self.FAILURE_RATE:
            raise ConnectionError("FCM error: Mismatched sender ID")
        
        msg_id = f"fcm_{uuid.uuid4().hex[:20]}"
        logger.info(f"[PUSH] device={device_token[:20]}... title='{title}' msg_id={msg_id}")
        return msg_id


# ============================================================================
# Deduplication Engine
# ============================================================================

class DeduplicationEngine:
    """
    Prevents duplicate notifications using idempotency keys.
    
    Key = hash(user_id + event_type + order_id or relevant unique field)
    
    Storage: in-memory dict with TTL cleanup (production: Redis with EXPIRE).
    Window: 24 hours (duplicate events within 24h are suppressed).
    
    Why this matters:
    - Mobile apps retry on network failure -> same event fired twice
    - Kafka at-least-once delivery -> event consumed twice
    - User double-clicks "Pay" -> two order_placed events
    Without dedup: user gets two "Order Confirmed" emails, two SMS charges.
    """
    
    TTL_SECONDS = 86400  # 24 hours
    
    def __init__(self):
        self._seen: dict[str, float] = {}  # key -> timestamp
    
    def _cleanup_expired(self) -> None:
        now = time.time()
        expired = [k for k, ts in self._seen.items() if now - ts > self.TTL_SECONDS]
        for k in expired:
            del self._seen[k]
    
    def is_duplicate(self, idempotency_key: str) -> bool:
        """Returns True if this key was already processed."""
        self._cleanup_expired()
        return idempotency_key in self._seen
    
    def mark_seen(self, idempotency_key: str) -> None:
        """Record that this idempotency key has been processed."""
        self._seen[idempotency_key] = time.time()


# ============================================================================
# Delivery Store
# ============================================================================

class DeliveryStore:
    """Tracks delivery status and history for each notification."""
    
    def __init__(self):
        self._records: dict[str, list[DeliveryRecord]] = defaultdict(list)
        self._latest: dict[str, DeliveryStatus] = {}
    
    def record(self, notification_id: str, channel: Channel,
               status: DeliveryStatus, attempt: int,
               error: Optional[str] = None, provider_id: Optional[str] = None) -> None:
        record = DeliveryRecord(
            notification_id=notification_id,
            channel=channel,
            status=status,
            attempt=attempt,
            timestamp=time.time(),
            error=error,
            provider_id=provider_id,
        )
        self._records[notification_id].append(record)
        self._latest[notification_id] = status
    
    def get_status(self, notification_id: str) -> Optional[DeliveryStatus]:
        return self._latest.get(notification_id)
    
    def get_history(self, notification_id: str) -> list:
        return [asdict(r) for r in self._records.get(notification_id, [])]


# ============================================================================
# Priority Queue (simple in-memory version)
# ============================================================================

class PriorityNotificationQueue:
    """
    Four priority queues. Workers drain higher-priority queues first.
    
    In production: Redis ZADD with score = priority * 1e9 - timestamp
    (negative priority = higher priority ranked first by ZPOPMIN)
    """
    
    PRIORITY_ORDER = [Priority.CRITICAL, Priority.HIGH, Priority.NORMAL, Priority.LOW]
    
    def __init__(self):
        self._queues: dict[Priority, deque] = {p: deque() for p in Priority}
    
    def enqueue(self, notification: Notification) -> None:
        self._queues[notification.priority].append(notification)
    
    def dequeue(self) -> Optional[Notification]:
        """Return next notification from highest available priority queue."""
        for priority in self.PRIORITY_ORDER:
            if self._queues[priority]:
                return self._queues[priority].popleft()
        return None
    
    def size(self) -> dict:
        return {p.value: len(q) for p, q in self._queues.items()}
    
    def total(self) -> int:
        return sum(len(q) for q in self._queues.values())


# ============================================================================
# Channel Worker
# ============================================================================

class ChannelWorker:
    """
    Worker that processes notifications from the queue and calls providers.
    
    Retry strategy: exponential backoff with jitter
    Attempt 1: immediately
    Attempt 2: 30s + jitter
    Attempt 3: 60s + jitter
    Attempt 4: 120s + jitter
    Attempt 5: 300s + jitter
    After 5 failures: send to DLQ
    """
    
    BASE_DELAYS = [0, 30, 60, 120, 300]  # Seconds before each retry
    
    def __init__(self, queue: PriorityNotificationQueue,
                 template_engine: TemplateEngine,
                 preference_engine: PreferenceEngine,
                 delivery_store: DeliveryStore,
                 email_provider: EmailProvider,
                 sms_provider: SMSProvider,
                 push_provider: PushProvider):
        self.queue = queue
        self.templates = template_engine
        self.preferences = preference_engine
        self.delivery = delivery_store
        self.email = email_provider
        self.sms = sms_provider
        self.push = push_provider
        self.dlq: list = []
        self.running = True
        self._processed = 0
    
    def _retry_delay(self, attempt: int) -> float:
        base = self.BASE_DELAYS[min(attempt, len(self.BASE_DELAYS) - 1)]
        jitter = random.uniform(0, base * 0.1)  # 10% jitter
        return base + jitter
    
    async def run(self) -> None:
        logger.info("Channel worker started")
        while self.running:
            notification = self.queue.dequeue()
            
            if notification is None:
                await asyncio.sleep(0.1)
                continue
            
            # Check if it's time to retry
            if notification.next_retry_at > time.time():
                self.queue.enqueue(notification)  # Re-enqueue, not ready yet
                await asyncio.sleep(0.05)
                continue
            
            await self._process(notification)
    
    async def _process(self, n: Notification) -> None:
        n.status = DeliveryStatus.SENDING
        n.attempt_count += 1
        
        try:
            # Get rendered template
            variables = n.variables.copy()
            rendered = self.templates.render(n.template_id, n.channel, variables, n.locale)
            
            # Get contact info
            contact = self.preferences.get_contact(n.user_id, n.channel)
            
            # Call provider
            if n.channel == Channel.EMAIL:
                provider_id = await self.email.send(
                    contact, rendered.get("subject", ""), rendered.get("body", "")
                )
            elif n.channel == Channel.SMS:
                provider_id = await self.sms.send(contact, rendered.get("body", ""))
            elif n.channel == Channel.PUSH:
                provider_id = await self.push.send(
                    contact, rendered.get("title", ""), rendered.get("body", "")
                )
            else:
                raise ValueError(f"Unknown channel: {n.channel}")
            
            # Success
            n.status = DeliveryStatus.DELIVERED
            self.delivery.record(n.id, n.channel, DeliveryStatus.DELIVERED,
                                 n.attempt_count, provider_id=provider_id)
            self._processed += 1
        
        except Exception as e:
            n.last_error = str(e)
            
            if n.attempt_count >= n.max_attempts:
                # Max retries exceeded -> DLQ
                n.status = DeliveryStatus.DEAD
                self.delivery.record(n.id, n.channel, DeliveryStatus.DEAD,
                                     n.attempt_count, error=str(e))
                self.dlq.append(asdict(n))
                logger.error(f"Notification {n.id} moved to DLQ after {n.attempt_count} attempts: {e}")
            else:
                # Schedule retry
                delay = self._retry_delay(n.attempt_count)
                n.next_retry_at = time.time() + delay
                n.status = DeliveryStatus.FAILED
                self.delivery.record(n.id, n.channel, DeliveryStatus.FAILED,
                                     n.attempt_count, error=str(e))
                self.queue.enqueue(n)  # Re-enqueue for retry
                logger.warning(f"Notification {n.id} failed (attempt {n.attempt_count}), "
                               f"retry in {delay:.0f}s: {e}")


# ============================================================================
# Notification Service (orchestrator)
# ============================================================================

class NotificationService:
    """
    Orchestrates the full notification pipeline:
    Event -> Dedup -> Preferences -> Template -> Queue -> Worker -> Provider
    """
    
    # Map event types to: channels, template_id, priority
    EVENT_CONFIG = {
        "order_placed": {
            "channels": [Channel.EMAIL, Channel.SMS, Channel.PUSH],
            "template_id": "order_placed",
            "priority": Priority.HIGH,
        },
        "password_reset": {
            "channels": [Channel.EMAIL, Channel.SMS],
            "template_id": "password_reset",
            "priority": Priority.CRITICAL,
        },
        "promo_weekly": {
            "channels": [Channel.EMAIL, Channel.PUSH],
            "template_id": "promo_weekly",
            "priority": Priority.LOW,
        },
    }
    
    def __init__(self):
        self.queue = PriorityNotificationQueue()
        self.templates = TemplateEngine()
        self.preferences = PreferenceEngine()
        self.delivery = DeliveryStore()
        self.dedup = DeduplicationEngine()
        
        self.worker = ChannelWorker(
            queue=self.queue,
            template_engine=self.templates,
            preference_engine=self.preferences,
            delivery_store=self.delivery,
            email_provider=EmailProvider(),
            sms_provider=SMSProvider(),
            push_provider=PushProvider(),
        )
    
    def notify(self, user_id: str, event_type: str, variables: dict,
               idempotency_key: Optional[str] = None) -> dict:
        """
        Trigger notifications for a user event.
        Returns: list of notification IDs created (one per channel).
        """
        config = self.EVENT_CONFIG.get(event_type)
        if not config:
            raise ValueError(f"Unknown event type: {event_type}")
        
        # Generate idempotency key if not provided
        if idempotency_key is None:
            raw = f"{user_id}:{event_type}:{json.dumps(variables, sort_keys=True)}"
            import hashlib
            idempotency_key = hashlib.sha256(raw.encode()).hexdigest()[:16]
        
        # Deduplication check
        if self.dedup.is_duplicate(idempotency_key):
            return {
                "status": "duplicate",
                "message": "Notification already sent for this idempotency key",
                "idempotency_key": idempotency_key,
            }
        
        self.dedup.mark_seen(idempotency_key)
        
        created_ids = []
        suppressed = []
        
        for channel in config["channels"]:
            # Check user preferences
            eligible, reason = self.preferences.is_eligible(
                user_id, channel, event_type, config["priority"]
            )
            
            if not eligible:
                suppressed.append({"channel": channel.value, "reason": reason})
                continue
            
            # Create notification
            notif = Notification(
                id=str(uuid.uuid4()),
                user_id=user_id,
                event_type=event_type,
                channel=channel,
                template_id=config["template_id"],
                variables=variables,
                priority=config["priority"],
                idempotency_key=idempotency_key,
            )
            
            # Enqueue
            self.queue.enqueue(notif)
            self.delivery.record(notif.id, channel, DeliveryStatus.PENDING, 0)
            created_ids.append(notif.id)
        
        return {
            "status": "queued",
            "notification_ids": created_ids,
            "channels_suppressed": suppressed,
            "queue_depth": self.queue.size(),
        }


# ============================================================================
# FastAPI Application
# ============================================================================

app = FastAPI(title="Notification Service", version="1.0")
service = NotificationService()


class NotifyRequest(BaseModel):
    user_id: str
    event_type: str
    variables: dict
    idempotency_key: Optional[str] = None


@app.post("/notify")
async def trigger_notification(req: NotifyRequest, background_tasks: BackgroundTasks):
    """Trigger a notification event for a user."""
    try:
        result = service.notify(
            user_id=req.user_id,
            event_type=req.event_type,
            variables=req.variables,
            idempotency_key=req.idempotency_key,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/delivery/{notification_id}")
async def get_delivery_status(notification_id: str):
    """Check delivery status for a notification."""
    status = service.delivery.get_status(notification_id)
    if status is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    
    return {
        "notification_id": notification_id,
        "status": status.value,
        "history": service.delivery.get_history(notification_id),
    }


@app.post("/preferences/{user_id}")
async def set_preferences(user_id: str, body: dict):
    """Update user notification preferences."""
    pref = UserPreference(
        user_id=user_id,
        email=body.get("email"),
        phone=body.get("phone"),
        device_token=body.get("device_token"),
        quiet_hours_start=body.get("quiet_hours_start", 22),
        quiet_hours_end=body.get("quiet_hours_end", 8),
        timezone=body.get("timezone", "UTC"),
    )
    
    # Parse channel opt-ins
    if "channels" in body:
        for channel, enabled in body["channels"].items():
            pref.channels[Channel(channel)] = enabled
    
    service.preferences.set_preference(user_id, pref)
    return {"status": "ok", "user_id": user_id}


@app.get("/queue/stats")
async def queue_stats():
    """Get current queue depth and DLQ size."""
    return {
        "queue_depth": service.queue.size(),
        "total_queued": service.queue.total(),
        "dead_letter_count": len(service.worker.dlq),
        "worker_processed": service.worker._processed,
    }


@app.get("/dlq")
async def get_dlq():
    """View failed notifications in dead letter queue."""
    return {
        "count": len(service.worker.dlq),
        "items": service.worker.dlq[:50],  # Show first 50
    }


@app.on_event("startup")
async def startup():
    """Start background worker on server startup."""
    asyncio.create_task(service.worker.run())
    logger.info("Worker started")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")
```

---

## Testing

```bash
# Start the server
uv run notification_system.py

# Set up user preferences (email + phone + push token)
curl -s -X POST http://localhost:8001/preferences/user_alice \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "phone": "+15551234567",
    "device_token": "fcm_abc123_token",
    "timezone": "America/New_York",
    "quiet_hours_start": 22,
    "quiet_hours_end": 8
  }' | jq .

# Trigger order_placed (all 3 channels)
curl -s -X POST http://localhost:8001/notify \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user_alice",
    "event_type": "order_placed",
    "variables": {
      "name": "Alice",
      "order_id": "ORD-9876",
      "amount": "$49.99",
      "delivery_date": "Dec 28"
    },
    "idempotency_key": "order-9876-notify"
  }' | jq .
# {
#   "status": "queued",
#   "notification_ids": ["notif-email-id", "notif-sms-id", "notif-push-id"],
#   "channels_suppressed": [],
#   "queue_depth": {"critical": 0, "high": 3, "normal": 0, "low": 0}
# }

# Trigger same event again (deduplication test!)
curl -s -X POST http://localhost:8001/notify \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user_alice", "event_type": "order_placed", "variables": {...}, "idempotency_key": "order-9876-notify"}' | jq .
# {"status": "duplicate", "message": "Notification already sent for this idempotency key"}

# Check delivery status
curl -s http://localhost:8001/delivery/{notification_id} | jq .
# {
#   "notification_id": "...",
#   "status": "delivered",
#   "history": [
#     {"status": "pending", "attempt": 0, ...},
#     {"status": "sending", "attempt": 1, ...},
#     {"status": "delivered", "attempt": 1, "provider_id": "sg_abc123"}
#   ]
# }

# Password reset (CRITICAL priority - bypasses quiet hours)
curl -s -X POST http://localhost:8001/notify \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user_alice",
    "event_type": "password_reset",
    "variables": {"name": "Alice", "app_name": "MyApp", "reset_link": "https://...", "otp_code": "123456"},
    "idempotency_key": "reset-unique-token-abc"
  }' | jq .

# Check queue stats
curl -s http://localhost:8001/queue/stats | jq .

# Check DLQ (after simulated failures)
curl -s http://localhost:8001/dlq | jq .
```

---

## Quiet Hours Logic

```text
Scenario: User in New York (UTC-5), quiet hours 10pm-8am
Current time: 11pm EST = 4am UTC

Event: promo_weekly (LOW priority)  -> SUPPRESSED (quiet hours)
Event: order_placed (HIGH priority) -> SUPPRESSED (quiet hours)
Event: password_reset (CRITICAL)    -> SENT (critical bypasses quiet hours)

How it works:
1. Convert current UTC time to user's local timezone
2. Check if local hour is in [quiet_hours_start, quiet_hours_end) range
3. Handles midnight wrap: start=22, end=8 -> in hours 22,23,0,1,2,3,4,5,6,7

For delayed notifications:
- Quiet-hours-suppressed events are discarded (not re-queued)
- Marketing systems use scheduled campaigns instead (send at 10am user local time)
- Production systems support "delay until morning window" for non-critical notifications
```

---

## Provider Failover Pattern

```python
class MultiProviderEmailService:
    """
    Automatic failover between email providers.
    Primary: SendGrid. Fallback: AWS SES.
    
    Health scoring: track success rate per provider.
    Switch providers when health drops below threshold.
    """
    
    def __init__(self):
        self.providers = [SendGridProvider(), AWSSESProvider()]
        self.health = {0: 1.0, 1: 1.0}  # provider_index -> success_rate
        self.request_count = {0: 0, 1: 0}
        self.success_count = {0: 0, 1: 0}
    
    async def send(self, to: str, subject: str, body: str) -> str:
        # Try primary first, then fallback
        for i, provider in enumerate(self.providers):
            if self.health[i] < 0.5 and i < len(self.providers) - 1:
                continue  # Skip unhealthy provider (unless it's the last one)
            
            try:
                result = await provider.send(to, subject, body)
                self._record_success(i)
                return result
            except Exception as e:
                self._record_failure(i)
                if i == len(self.providers) - 1:
                    raise  # All providers failed
                logger.warning(f"Provider {i} failed, trying next: {e}")
    
    def _record_success(self, idx: int) -> None:
        self.request_count[idx] += 1
        self.success_count[idx] += 1
        self.health[idx] = self.success_count[idx] / self.request_count[idx]
    
    def _record_failure(self, idx: int) -> None:
        self.request_count[idx] += 1
        self.health[idx] = self.success_count[idx] / self.request_count[idx]
```

---

## Key Learning Points

```text
1. Idempotency is non-negotiable for notifications:
   - Mobile apps retry on 5xx -> same event sent twice
   - Kafka at-least-once -> event consumed twice
   - Without idempotency: double emails, double SMS charges
   - Key = hash(user_id + event_type + unique business identifier)

2. Priority queues prevent critical from starving under load:
   - During a flash sale: millions of promo notifications queue up
   - Without priority: OTP notifications (security) stuck behind promos
   - CRITICAL queue always drained first, regardless of queue depth

3. Quiet hours respect is a legal/trust requirement:
   - Violating quiet hours destroys user trust and may violate CAN-SPAM, TCPA
   - CRITICAL (OTP, security) bypasses by design: users expect this
   - Non-critical is either suppressed or delayed to morning

4. Retry with exponential backoff + jitter:
   - Without jitter: all failures retry at the same time -> thundering herd
   - Jitter spreads retries: 30s + random(0, 3s), 60s + random(0, 6s), etc.
   - Max attempts = 5 is typical; beyond that is permanent failure (DLQ)

5. Dead Letter Queue over silent drops:
   - Never silently drop failed notifications
   - DLQ allows: manual inspection, replay after fixing the bug, SLA analysis
   - Alert on DLQ growth rate: > N items/hour means something is broken

6. Provider abstraction enables failover:
   - Abstract each channel behind an interface
   - Multiple providers per channel (SendGrid + AWS SES for email)
   - Route to healthy provider based on success rate tracking
   - Graceful degradation: if all email providers fail, still send push

7. Template engine decouples content from code:
   - Notifications team can update copy without code deploy
   - Locale/language support without code changes
   - A/B testing different messages without touching delivery code
```
