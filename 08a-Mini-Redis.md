# Project 1: Mini Redis (In-Memory KV Store)

## Goal
Build a working in-memory key-value store that:
- Accepts TCP connections and parses RESP-like protocol
- Supports: GET, SET, DEL, EXISTS, EXPIRE, TTL, MGET, INCR
- Implements LRU eviction when memory is full
- Supports persistence via Append-Only File (AOF)

This project teaches: TCP server design, protocol parsing, LRU eviction, AOF durability.

---

## Architecture
```text
TCP Client
    |  (raw bytes: "*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n")
    v
[TCP Listener]              <- asyncio TCP server, accepts connections
    |
    v
[Connection Handler]        <- One coroutine per client connection
    |
    v
[RESP Parser]               <- Parses Redis Serialization Protocol
    |  (("SET", "foo", "bar"))
    v
[Command Router]            <- Maps command name -> handler function
    |
    +----> [KV Store]        <- OrderedDict (LRU order)
    +----> [TTL Index]       <- key -> expiry timestamp
    +----> [Eviction Manager] <- LRU eviction when memory limit hit
    +----> [AOF Writer]      <- Append commands to log file
```

---

## Full Working Implementation

```python
#!/usr/bin/env python3
"""
mini_redis.py - A working in-memory key-value store.

Run:   uv run mini_redis.py
Test:  redis-cli -p 6380 SET foo bar
       redis-cli -p 6380 GET foo
       redis-cli -p 6380 INCR counter
"""
# /// script
# dependencies = ["uvloop"]
# ///

import asyncio
import time
import os
import struct
from collections import OrderedDict
from typing import Optional


# ============================================================================
# LRU Store: in-memory key-value store with LRU eviction
# ============================================================================

class LRUStore:
    def __init__(self, max_memory_mb: int = 64):
        self.max_bytes = max_memory_mb * 1024 * 1024
        self.used_bytes = 0
        self.store: OrderedDict = OrderedDict()   # key -> bytes
        self.ttl: dict = {}                        # key -> expiry timestamp (seconds)
        
        self.stats = {
            "hits": 0, "misses": 0,
            "evictions": 0, "expired": 0,
            "total_commands": 0,
        }
    
    def _is_expired(self, key: str) -> bool:
        exp = self.ttl.get(key)
        return exp is not None and time.time() > exp
    
    def _evict_if_expired(self, key: str) -> bool:
        if self._is_expired(key):
            self._delete(key)
            self.stats["expired"] += 1
            return True
        return False
    
    def _entry_size(self, key: str, value: bytes) -> int:
        return len(key.encode()) + len(value) + 64  # overhead
    
    def _make_room(self, needed_bytes: int) -> None:
        """LRU eviction: remove oldest items until we have enough space."""
        while self.used_bytes + needed_bytes > self.max_bytes and self.store:
            # OrderedDict: first item = least recently used
            evict_key = next(iter(self.store))
            self._delete(evict_key)
            self.stats["evictions"] += 1
    
    def _delete(self, key: str) -> bool:
        if key not in self.store:
            return False
        v = self.store.pop(key)
        self.used_bytes -= self._entry_size(key, v)
        self.ttl.pop(key, None)
        return True
    
    # ---- Public commands ----
    
    def get(self, key: str) -> Optional[bytes]:
        self.stats["total_commands"] += 1
        if self._evict_if_expired(key) or key not in self.store:
            self.stats["misses"] += 1
            return None
        # Move to end = mark as recently used (LRU update)
        self.store.move_to_end(key)
        self.stats["hits"] += 1
        return self.store[key]
    
    def set(self, key: str, value: bytes, ex: Optional[int] = None,
            px: Optional[int] = None, nx: bool = False, xx: bool = False) -> bool:
        self.stats["total_commands"] += 1
        
        if nx and key in self.store and not self._is_expired(key):
            return False   # NX: only set if not exists
        if xx and (key not in self.store or self._is_expired(key)):
            return False   # XX: only set if exists
        
        # Evict old entry
        if key in self.store:
            self._delete(key)
        
        # Make room via LRU eviction
        needed = self._entry_size(key, value)
        self._make_room(needed)
        
        self.store[key] = value
        self.used_bytes += needed
        
        if ex is not None:
            self.ttl[key] = time.time() + ex
        elif px is not None:
            self.ttl[key] = time.time() + px / 1000.0
        
        return True
    
    def delete(self, *keys: str) -> int:
        self.stats["total_commands"] += 1
        return sum(1 for k in keys if self._delete(k))
    
    def exists(self, *keys: str) -> int:
        self.stats["total_commands"] += 1
        return sum(
            1 for k in keys
            if k in self.store and not self._evict_if_expired(k)
        )
    
    def expire(self, key: str, seconds: int) -> int:
        if key not in self.store or self._is_expired(key):
            return 0
        self.ttl[key] = time.time() + seconds
        return 1
    
    def ttl_remaining(self, key: str) -> int:
        """Returns TTL in seconds. -1 = no TTL, -2 = key doesn't exist."""
        if key not in self.store or self._is_expired(key):
            return -2
        exp = self.ttl.get(key)
        if exp is None:
            return -1
        remaining = int(exp - time.time())
        return max(0, remaining)
    
    def incr(self, key: str, by: int = 1) -> int:
        self.stats["total_commands"] += 1
        current = self.get(key)
        if current is None:
            new_val = by
        else:
            try:
                new_val = int(current.decode()) + by
            except ValueError:
                raise ValueError("ERR value is not an integer or out of range")
        self.set(key, str(new_val).encode())
        return new_val
    
    def keys(self, pattern: str = "*") -> list:
        """List all keys matching pattern (simplified: only '*' supported)."""
        import fnmatch
        result = []
        for k in list(self.store.keys()):
            if not self._is_expired(k) and fnmatch.fnmatch(k, pattern):
                result.append(k)
        return result
    
    def dbsize(self) -> int:
        return sum(1 for k in self.store if not self._is_expired(k))
    
    def flushdb(self) -> None:
        self.store.clear()
        self.ttl.clear()
        self.used_bytes = 0
    
    def info(self) -> dict:
        total = self.stats["hits"] + self.stats["misses"]
        return {
            **self.stats,
            "keyspace_hits": self.stats["hits"],
            "keyspace_misses": self.stats["misses"],
            "hit_rate": f"{self.stats['hits'] / total:.2%}" if total else "0%",
            "used_memory_bytes": self.used_bytes,
            "used_memory_mb": round(self.used_bytes / (1024**2), 2),
            "max_memory_mb": self.max_bytes // (1024**2),
            "db_size": self.dbsize(),
        }


# ============================================================================
# RESP Protocol: Redis Serialization Protocol
# ============================================================================

class RESPParser:
    """
    Parse Redis wire protocol (RESP).
    
    RESP types:
    +OK\r\n              Simple string
    -ERR msg\r\n         Error
    :42\r\n              Integer
    $6\r\nfoobar\r\n     Bulk string
    *3\r\n$3\r\nSET...   Array (commands are always arrays)
    """
    
    @staticmethod
    def parse(data: bytes) -> tuple:
        """Parse one command from bytes. Returns (command_list, bytes_consumed)."""
        if not data:
            return None, 0
        
        if data[0:1] == b'*':
            # Array
            end = data.find(b'\r\n')
            if end == -1:
                return None, 0
            count = int(data[1:end])
            idx = end + 2
            items = []
            for _ in range(count):
                if idx >= len(data):
                    return None, 0
                if data[idx:idx+1] == b'$':
                    end2 = data.find(b'\r\n', idx)
                    if end2 == -1:
                        return None, 0
                    length = int(data[idx+1:end2])
                    start = end2 + 2
                    end3 = start + length
                    if end3 + 2 > len(data):
                        return None, 0
                    items.append(data[start:end3].decode(errors='replace'))
                    idx = end3 + 2
            return items, idx
        
        # Inline command (e.g., from redis-cli in inline mode)
        end = data.find(b'\r\n')
        if end == -1:
            end = data.find(b'\n')
        if end == -1:
            return None, 0
        parts = data[:end].decode().split()
        return parts, end + 2
    
    @staticmethod
    def encode_simple_string(s: str) -> bytes:
        return f"+{s}\r\n".encode()
    
    @staticmethod
    def encode_error(msg: str) -> bytes:
        return f"-ERR {msg}\r\n".encode()
    
    @staticmethod
    def encode_integer(n: int) -> bytes:
        return f":{n}\r\n".encode()
    
    @staticmethod
    def encode_bulk_string(data: Optional[bytes]) -> bytes:
        if data is None:
            return b"$-1\r\n"
        return f"${len(data)}\r\n".encode() + data + b"\r\n"
    
    @staticmethod
    def encode_array(items: list) -> bytes:
        if items is None:
            return b"*-1\r\n"
        result = f"*{len(items)}\r\n".encode()
        for item in items:
            if item is None:
                result += b"$-1\r\n"
            elif isinstance(item, bytes):
                result += RESPParser.encode_bulk_string(item)
            elif isinstance(item, int):
                result += RESPParser.encode_integer(item)
            elif isinstance(item, str):
                result += RESPParser.encode_bulk_string(item.encode())
        return result


# ============================================================================
# AOF (Append-Only File) Persistence
# ============================================================================

class AOFWriter:
    """
    Append write commands to a log file.
    On restart: replay log to restore state.
    
    Format: same as RESP wire format.
    Each write command is serialized and appended.
    """
    
    def __init__(self, path: str = "mini_redis.aof"):
        self.path = path
        self.fh = None
        self.fsync_policy = "everysec"   # "always", "everysec", "no"
        self._pending_fsync = False
    
    def open(self) -> None:
        self.fh = open(self.path, "ab")
    
    def close(self) -> None:
        if self.fh:
            self.fh.flush()
            os.fsync(self.fh.fileno())
            self.fh.close()
    
    def append(self, command_parts: list) -> None:
        """Serialize command in RESP format and write to AOF."""
        if not self.fh:
            return
        data = RESPParser.encode_array([p.encode() if isinstance(p, str) else p 
                                         for p in command_parts])
        self.fh.write(data)
        
        if self.fsync_policy == "always":
            self.fh.flush()
            os.fsync(self.fh.fileno())
        elif self.fsync_policy == "everysec":
            self.fh.flush()
            # Actual fsync happens once per second in background
    
    def replay(self, store: LRUStore) -> int:
        """Replay AOF to restore state on startup."""
        if not os.path.exists(self.path):
            return 0
        
        restored = 0
        with open(self.path, "rb") as f:
            data = f.read()
        
        pos = 0
        while pos < len(data):
            cmd, consumed = RESPParser.parse(data[pos:])
            if cmd is None:
                break
            pos += consumed
            # Execute command against store
            if cmd and cmd[0].upper() == "SET":
                args = cmd[1:]
                store.set(args[0], args[1].encode() if isinstance(args[1], str) else args[1])
                restored += 1
            elif cmd and cmd[0].upper() == "DEL":
                store.delete(*cmd[1:])
        
        return restored


# ============================================================================
# Command Handler
# ============================================================================

class CommandHandler:
    def __init__(self, store: LRUStore, aof: AOFWriter):
        self.store = store
        self.aof = aof
        self.commands = {
            "PING": self.cmd_ping,
            "SET": self.cmd_set,
            "GET": self.cmd_get,
            "DEL": self.cmd_del,
            "EXISTS": self.cmd_exists,
            "EXPIRE": self.cmd_expire,
            "TTL": self.cmd_ttl,
            "INCR": self.cmd_incr,
            "INCRBY": self.cmd_incrby,
            "MGET": self.cmd_mget,
            "MSET": self.cmd_mset,
            "KEYS": self.cmd_keys,
            "DBSIZE": self.cmd_dbsize,
            "FLUSHDB": self.cmd_flushdb,
            "INFO": self.cmd_info,
            "COMMAND": self.cmd_command,
        }
    
    def execute(self, parts: list) -> bytes:
        if not parts:
            return RESPParser.encode_error("empty command")
        
        cmd_name = parts[0].upper()
        handler = self.commands.get(cmd_name)
        
        if not handler:
            return RESPParser.encode_error(f"unknown command '{cmd_name}'")
        
        try:
            return handler(parts[1:])
        except ValueError as e:
            return RESPParser.encode_error(str(e))
        except Exception as e:
            return RESPParser.encode_error(f"internal error: {e}")
    
    def cmd_ping(self, args: list) -> bytes:
        if args:
            return RESPParser.encode_bulk_string(args[0].encode())
        return RESPParser.encode_simple_string("PONG")
    
    def cmd_set(self, args: list) -> bytes:
        if len(args) < 2:
            return RESPParser.encode_error("wrong number of arguments for 'set'")
        
        key, value = args[0], args[1].encode() if isinstance(args[1], str) else args[1]
        ex = px = None
        nx = xx = False
        
        i = 2
        while i < len(args):
            opt = args[i].upper()
            if opt == "EX" and i + 1 < len(args):
                ex = int(args[i+1]); i += 2
            elif opt == "PX" and i + 1 < len(args):
                px = int(args[i+1]); i += 2
            elif opt == "NX":
                nx = True; i += 1
            elif opt == "XX":
                xx = True; i += 1
            else:
                i += 1
        
        result = self.store.set(key, value, ex=ex, px=px, nx=nx, xx=xx)
        
        if result:
            self.aof.append(["SET", key, value.decode()] + 
                           (["EX", str(ex)] if ex else []))
            return RESPParser.encode_simple_string("OK")
        return RESPParser.encode_bulk_string(None)  # nil = NX/XX condition not met
    
    def cmd_get(self, args: list) -> bytes:
        if len(args) != 1:
            return RESPParser.encode_error("wrong number of arguments for 'get'")
        return RESPParser.encode_bulk_string(self.store.get(args[0]))
    
    def cmd_del(self, args: list) -> bytes:
        if not args:
            return RESPParser.encode_error("wrong number of arguments for 'del'")
        return RESPParser.encode_integer(self.store.delete(*args))
    
    def cmd_exists(self, args: list) -> bytes:
        return RESPParser.encode_integer(self.store.exists(*args))
    
    def cmd_expire(self, args: list) -> bytes:
        if len(args) != 2:
            return RESPParser.encode_error("wrong number of arguments for 'expire'")
        return RESPParser.encode_integer(self.store.expire(args[0], int(args[1])))
    
    def cmd_ttl(self, args: list) -> bytes:
        if len(args) != 1:
            return RESPParser.encode_error("wrong number of arguments for 'ttl'")
        return RESPParser.encode_integer(self.store.ttl_remaining(args[0]))
    
    def cmd_incr(self, args: list) -> bytes:
        if len(args) != 1:
            return RESPParser.encode_error("wrong number of arguments for 'incr'")
        new_val = self.store.incr(args[0])
        self.aof.append(["INCR", args[0]])
        return RESPParser.encode_integer(new_val)
    
    def cmd_incrby(self, args: list) -> bytes:
        if len(args) != 2:
            return RESPParser.encode_error("wrong number of arguments for 'incrby'")
        new_val = self.store.incr(args[0], int(args[1]))
        self.aof.append(["INCRBY", args[0], args[1]])
        return RESPParser.encode_integer(new_val)
    
    def cmd_mget(self, args: list) -> bytes:
        results = [self.store.get(k) for k in args]
        return RESPParser.encode_array(results)
    
    def cmd_mset(self, args: list) -> bytes:
        if len(args) % 2 != 0:
            return RESPParser.encode_error("wrong number of arguments for 'mset'")
        for i in range(0, len(args), 2):
            value = args[i+1].encode() if isinstance(args[i+1], str) else args[i+1]
            self.store.set(args[i], value)
        return RESPParser.encode_simple_string("OK")
    
    def cmd_keys(self, args: list) -> bytes:
        pattern = args[0] if args else "*"
        keys = self.store.keys(pattern)
        return RESPParser.encode_array([k.encode() for k in keys])
    
    def cmd_dbsize(self, args: list) -> bytes:
        return RESPParser.encode_integer(self.store.dbsize())
    
    def cmd_flushdb(self, args: list) -> bytes:
        self.store.flushdb()
        self.aof.fh and self.aof.fh.truncate(0)  # Clear AOF
        return RESPParser.encode_simple_string("OK")
    
    def cmd_info(self, args: list) -> bytes:
        info = self.store.info()
        lines = [f"{k}:{v}" for k, v in info.items()]
        text = "\r\n".join(lines) + "\r\n"
        return RESPParser.encode_bulk_string(text.encode())
    
    def cmd_command(self, args: list) -> bytes:
        return RESPParser.encode_array([k.encode() for k in self.commands])


# ============================================================================
# TCP Server
# ============================================================================

class MiniRedisServer:
    def __init__(self, host: str = "127.0.0.1", port: int = 6380,
                 max_memory_mb: int = 64, aof_path: str = "mini_redis.aof"):
        self.host = host
        self.port = port
        self.store = LRUStore(max_memory_mb)
        self.aof = AOFWriter(aof_path)
        self.handler = CommandHandler(self.store, self.aof)
        self._connections = 0
    
    async def handle_client(self, reader: asyncio.StreamReader,
                            writer: asyncio.StreamWriter) -> None:
        self._connections += 1
        addr = writer.get_extra_info("peername")
        print(f"[+] New connection from {addr}")
        
        buffer = b""
        
        try:
            while True:
                # Read data
                try:
                    chunk = await asyncio.wait_for(reader.read(4096), timeout=300)
                except asyncio.TimeoutError:
                    break
                
                if not chunk:
                    break
                
                buffer += chunk
                
                # Process all complete commands in buffer
                while buffer:
                    cmd_parts, consumed = RESPParser.parse(buffer)
                    if cmd_parts is None:
                        break  # Need more data
                    buffer = buffer[consumed:]
                    
                    response = self.handler.execute(cmd_parts)
                    writer.write(response)
                
                await writer.drain()
        
        except ConnectionResetError:
            pass
        finally:
            self._connections -= 1
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            print(f"[-] Connection closed from {addr}")
    
    async def run(self) -> None:
        # Restore from AOF on startup
        self.aof.open()
        restored = self.aof.replay(self.store)
        if restored > 0:
            print(f"[*] Restored {restored} keys from AOF")
        
        server = await asyncio.start_server(
            self.handle_client, self.host, self.port
        )
        
        print(f"[*] Mini Redis listening on {self.host}:{self.port}")
        print(f"[*] Max memory: {self.store.max_bytes // (1024**2)} MB")
        print(f"[*] Connect with: redis-cli -p {self.port}")
        
        async with server:
            await server.serve_forever()


# ============================================================================
# Main
# ============================================================================

if __name__ == "__main__":
    import uvloop
    asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
    
    server = MiniRedisServer(
        host="127.0.0.1",
        port=6380,
        max_memory_mb=64,
        aof_path="mini_redis.aof"
    )
    
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        print("\n[*] Shutting down...")
        server.aof.close()
```

---

## Testing the Server

```bash
# Start server
uv run mini_redis.py

# In another terminal, use redis-cli to test:
redis-cli -p 6380 PING
# PONG

redis-cli -p 6380 SET name "Alice"
# OK

redis-cli -p 6380 GET name
# "Alice"

redis-cli -p 6380 SET counter 0
redis-cli -p 6380 INCR counter
redis-cli -p 6380 INCR counter
redis-cli -p 6380 GET counter
# "2"

# TTL test
redis-cli -p 6380 SET temp "expires soon" EX 10
redis-cli -p 6380 TTL temp
# (integer) 9
sleep 11
redis-cli -p 6380 GET temp
# (nil)  <- expired!

# MGET test
redis-cli -p 6380 MSET k1 v1 k2 v2 k3 v3
redis-cli -p 6380 MGET k1 k2 k3 missing
# 1) "v1"
# 2) "v2"
# 3) "v3"
# 4) (nil)

# INFO
redis-cli -p 6380 INFO
```

---

## Benchmark Test

```python
# bench.py - Measure throughput of mini_redis
import socket
import time

def run_benchmark(host="127.0.0.1", port=6380, num_ops=10_000):
    sock = socket.socket()
    sock.connect((host, port))
    
    # Pipeline: send all commands before reading responses
    start = time.time()
    
    # Batch SET commands
    pipeline = b""
    for i in range(num_ops):
        cmd = f"*3\r\n$3\r\nSET\r\n$5\r\nkey{i}\r\n$5\r\nval{i}\r\n"
        pipeline += cmd.encode()
    
    sock.sendall(pipeline)
    
    # Read all responses
    received = 0
    buf = b""
    while received < num_ops:
        buf += sock.recv(65536)
        received += buf.count(b"+OK\r\n")
        buf = buf[buf.rfind(b"+OK\r\n") + 5:] if b"+OK\r\n" in buf else buf
    
    elapsed = time.time() - start
    print(f"SET throughput: {num_ops / elapsed:.0f} ops/sec")
    
    sock.close()

if __name__ == "__main__":
    run_benchmark()
# Expected: ~50,000-100,000 ops/sec (Python async TCP)
# Redis itself: ~100,000-150,000 ops/sec (C single-threaded)
```

---

## Extension Challenges

### 1. Add Hash data type (HSET, HGET, HGETALL)
```python
# Extension: store values as dicts when type = "hash"
def cmd_hset(self, args: list) -> bytes:
    """HSET key field value [field value ...]"""
    key, field, value = args[0], args[1], args[2]
    current = self.store.get(key)
    h = {} if current is None else json.loads(current.decode())
    h[field] = value
    self.store.set(key, json.dumps(h).encode())
    return RESPParser.encode_integer(1)

def cmd_hget(self, args: list) -> bytes:
    """HGET key field"""
    key, field = args[0], args[1]
    raw = self.store.get(key)
    if raw is None:
        return RESPParser.encode_bulk_string(None)
    h = json.loads(raw.decode())
    value = h.get(field)
    return RESPParser.encode_bulk_string(value.encode() if value else None)
```

### 2. Add Pub/Sub
```python
# Extension: PUBLISH channel message / SUBSCRIBE channel
class PubSubManager:
    def __init__(self):
        self.channels = {}  # channel -> set of writer objects
    
    def subscribe(self, channel: str, writer: asyncio.StreamWriter) -> None:
        if channel not in self.channels:
            self.channels[channel] = set()
        self.channels[channel].add(writer)
    
    async def publish(self, channel: str, message: str) -> int:
        subscribers = self.channels.get(channel, set())
        alive = set()
        for writer in subscribers:
            try:
                msg = RESPParser.encode_array([
                    b"message", channel.encode(), message.encode()
                ])
                writer.write(msg)
                await writer.drain()
                alive.add(writer)
            except Exception:
                pass  # Dead connection, remove
        self.channels[channel] = alive
        return len(alive)
```

### 3. Add Sorted Sets (ZADD, ZRANGE, ZRANK)
```python
import heapq
from sortedcontainers import SortedList

class SortedSetStore:
    def __init__(self):
        self.sets = {}  # key -> SortedList of (score, member)
    
    def zadd(self, key: str, score: float, member: str) -> int:
        if key not in self.sets:
            self.sets[key] = SortedList(key=lambda x: x[0])
        # Remove existing member (update score)
        self.sets[key] = SortedList(
            [(s, m) for s, m in self.sets[key] if m != member],
            key=lambda x: x[0]
        )
        self.sets[key].add((score, member))
        return 1
    
    def zrange(self, key: str, start: int, stop: int) -> list:
        if key not in self.sets:
            return []
        items = list(self.sets[key])
        if stop == -1:
            stop = len(items)
        return [member for _, member in items[start:stop+1]]
    
    def zrank(self, key: str, member: str) -> Optional[int]:
        if key not in self.sets:
            return None
        for i, (score, m) in enumerate(self.sets[key]):
            if m == member:
                return i
        return None
```

---

## Key Learning Points

```text
1. RESP protocol: simple, text-based, easy to parse with indexOf + slice operations
2. LRU eviction: OrderedDict naturally maintains insertion order;
   move_to_end() = O(1); popitem(last=False) = O(1)
3. TTL: lazy expiration (check on access) vs active expiration (background timer)
   Redis uses both: lazy on access + background scan of random keys every 100ms
4. AOF: every write command is appended; on restart, replay to rebuild state
   Trade-off: AOF grows indefinitely -> need periodic compaction (BGREWRITEAOF)
5. Single-threaded: Redis is single-threaded (one command at a time)
   asyncio in Python achieves same: event loop processes one coroutine at a time
   No locking needed for in-memory data structures
6. Connection handling: one coroutine per connection, buffer incomplete frames
```
