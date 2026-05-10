# Project 7: Scalable Notification System

## Architecture
```text
Event Intake -> Preference Engine -> Routing -> Channel Workers (Email/SMS/Push)
                                              -> Provider Adapters
                                              -> Delivery Status Store
```

## Tech choices
- Queue + workers
- Template engine
- Provider SDK adapters

## Step-by-step plan
1. Define event schema and notification contract.
2. Build user preference evaluation.
3. Implement channel selection/routing.
4. Render templates with localization.
5. Retry with backoff + DLQ.
6. Track delivery/open/click status.

## Scaling improvements
- Priority queues (critical vs bulk).
- Batch sending and provider-level throttling.
- Multi-provider failover.

## Production concerns
- Idempotency for duplicate events
- Quiet hours and legal compliance
- Anti-spam and reputation management

## Exercises
1. Add per-tenant rate limits.
2. Design incident mode to disable non-critical notifications.

## Extended Build Tasks

### Preference and policy model
- Channel-level opt-in/out
- Quiet hours and locale-aware scheduling
- Priority classes (critical/high/normal/low)

### Delivery guarantees
- At-least-once send with idempotent provider request keys
- Final-state reconciliation from provider callbacks

### Reliability controls
- Provider health scoring
- Automatic channel fallback
- Dead-letter workflow with replay

## Sophisticated Build Expansion

### Real-world equivalent
Notification platforms support transactional email, push, SMS, marketing campaigns, provider failover, user preferences, and compliance rules.

### Architecture
```text
Event Intake -> Deduplication -> Preference Engine -> Template Renderer
                                            -> Priority Queues
                                            -> Channel Workers
                                            -> Provider Adapters
                                            -> Delivery Status Store
```

### Advanced topics
- Quiet hours and timezone-aware scheduling.
- Locale and template versioning.
- Provider rate limits.
- Channel fallback.
- Exactly-once illusion with provider idempotency keys.
- Unsubscribe and legal compliance.

### Production questions
- Which notifications are critical?
- What happens when a provider is down?
- How are duplicate sends prevented?
- How are user preferences enforced consistently?

## Rigorous Acceptance Criteria

### Minimum architecture
```text
Event Intake -> Deduplication -> Preferences -> Template Render
                                  -> Priority Queue
                                  -> Channel Worker
                                  -> Provider Adapter
                                  -> Delivery Store
```

### Required behaviors
- Duplicate event does not send duplicate notification.
- User opt-out is enforced.
- Quiet hours delay non-critical notifications.
- Provider failure retries with backoff.
- Permanent failure goes to DLQ.
- Delivery status is queryable.

### Failure tests
- Provider timeout.
- Invalid template.
- Duplicate event.
- Tenant exceeds send quota.
