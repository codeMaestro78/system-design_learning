const crypto = require("crypto");

class ConsistentHashRing {
  constructor({ virtualNodes = 100 } = {}) {
    this.virtualNodes = virtualNodes;
    this.ring = [];
    this.nodeMap = new Map();
  }

  _hash(input) {
    return crypto.createHash("sha1").update(String(input)).digest("hex");
  }

  _insertPoint(hash, nodeId) {
    this.ring.push({ hash, nodeId });
  }

  _sortRing() {
    this.ring.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  }

  addNode(nodeId) {
    if (this.nodeMap.has(nodeId)) {
      return;
    }
    const hashes = [];
    for (let i = 0; i < this.virtualNodes; i += 1) {
      const hash = this._hash(`${nodeId}:${i}`);
      this._insertPoint(hash, nodeId);
      hashes.push(hash);
    }
    this.nodeMap.set(nodeId, hashes);
    this._sortRing();
  }

  removeNode(nodeId) {
    const hashes = this.nodeMap.get(nodeId);
    if (!hashes) {
      return;
    }
    const hashSet = new Set(hashes);
    this.ring = this.ring.filter((entry) => !hashSet.has(entry.hash));
    this.nodeMap.delete(nodeId);
  }

  getNode(key) {
    if (this.ring.length === 0) {
      return null;
    }
    const target = this._hash(key);
    let lo = 0;
    let hi = this.ring.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.ring[mid].hash >= target) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (this.ring[ans].hash < target) {
      return this.ring[0].nodeId;
    }
    return this.ring[ans].nodeId;
  }

  getReplicas(key, count = 2) {
    if (this.ring.length === 0 || count <= 0) {
      return [];
    }
    const target = this._hash(key);
    let idx = this.ring.findIndex((entry) => entry.hash >= target);
    if (idx === -1) {
      idx = 0;
    }
    const result = [];
    const seen = new Set();
    for (let i = 0; i < this.ring.length && result.length < count; i += 1) {
      const nodeId = this.ring[(idx + i) % this.ring.length].nodeId;
      if (!seen.has(nodeId)) {
        seen.add(nodeId);
        result.push(nodeId);
      }
    }
    return result;
  }

  snapshot() {
    return {
      nodes: [...this.nodeMap.keys()],
      ringPoints: this.ring.length,
      virtualNodes: this.virtualNodes,
    };
  }
}

module.exports = { ConsistentHashRing };
