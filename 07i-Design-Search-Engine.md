# Design a Search Engine (Comprehensive)

## 1) Intuition
A search engine maps free-text queries to relevant ranked documents. The core data structure is an **inverted index**: instead of document → words, it's word → list of documents containing that word.

The three main subsystems:
1. **Crawling:** Discover and download web pages (the input data)
2. **Indexing:** Build the inverted index (the data structure)
3. **Ranking & Serving:** Given a query, return the most relevant results in < 200ms

Real-world analogy: A search engine is like a book index, but for the entire internet. When you look at the back of a book, you see "topic → page numbers". An inverted index is the same: "word → document IDs". Ranking is like having an expert librarian who not only finds all mentions of a word but tells you which book is most authoritative on that topic.

---

## 2) Functional Requirements (Web Search like Google)
- Crawl and index web pages continuously
- Full-text search with ranking
- Autocomplete / query suggestions
- Spell correction ("Did you mean...?")
- Structured snippets (title, URL, description)
- Freshness: breaking news indexed within minutes
- Personalization (optional)

---

## 3) Non-Functional Requirements
- **Query latency:** P99 < 200ms
- **Index freshness:** 90% of new content indexed within 24 hours; breaking news < 5 min
- **Availability:** 99.99%
- **Scale:** 60 trillion indexed pages, 8.5 billion queries/day

---

## 4) Capacity Estimation

```python
google_scale = {
    # Index
    "indexed_pages": 60_000_000_000_000,  # 60 trillion
    "avg_page_size_bytes": 30_000,          # 30 KB cleaned text
    "raw_content_pb": 60e12 * 30_000 / (1024**5),  # ~1.6 exabytes
    
    "avg_unique_words_per_page": 500,
    "inverted_index_entries": 60e12 * 500,  # 30 quadrillion index entries
    # Each entry: (word, doc_id, position, TF score)
    # Size: ~30 bytes per entry
    "inverted_index_size_pb": 30e15 * 30 / (1024**5),  # ~800 PB just for index!
    # In practice: aggressive compression, tiered storage, sharding
    
    # Queries
    "queries_per_day": 8_500_000_000,    # 8.5B queries/day
    "queries_per_second_avg": 98_380,
    "queries_per_second_peak": 295_000,  # 3x peak
    
    # Crawling
    "pages_crawled_per_day": 6_000_000_000,  # 6B pages/day to keep index fresh
    "pages_crawled_per_second": 69_444,
    "crawl_bandwidth_gbps": 69_444 * 30_000 / (1024**3) * 8,  # ~15.5 Gbps
}
```

---

## 5) Inverted Index

```python
# The core data structure

# Example documents:
doc_1 = "The quick brown fox jumps over the lazy dog"
doc_2 = "The fox was quick and the dog was lazy"
doc_3 = "A quick brown rabbit jumps high"

# Inverted index (after tokenization + normalization):
inverted_index = {
    "quick":  [1, 2, 3],   # doc IDs containing "quick"
    "brown":  [1, 3],
    "fox":    [1, 2],
    "jump":   [1, 3],      # "jumps" -> stemmed to "jump"
    "lazy":   [1, 2],
    "dog":    [1, 2],
    "rabbit": [3],
    "high":   [3],
}

# For ranking, each entry also stores:
# - TF (term frequency): how often word appears in this doc
# - IDF (inverse document frequency): how rare the word is across all docs
# - Position list: where in document the word appears (for phrase matching)

detailed_index = {
    "quick": [
        {"doc_id": 1, "tf": 1, "positions": [2], "title_match": True},
        {"doc_id": 2, "tf": 1, "positions": [4]},
        {"doc_id": 3, "tf": 1, "positions": [2]},
    ],
    "fox": [
        {"doc_id": 1, "tf": 1, "positions": [4]},
        {"doc_id": 2, "tf": 1, "positions": [2]},
    ],
}
```

### Index construction (distributed)
```python
class InvertedIndexBuilder:
    """
    Build inverted index from crawled documents.
    MapReduce-style distributed processing.
    """
    
    def process_document(self, doc_id: str, raw_html: str) -> list:
        """
        Map phase: emit (word, doc_id) pairs from one document.
        """
        # 1. Parse HTML, extract text
        text = self._extract_text(raw_html)
        title = self._extract_title(raw_html)
        
        # 2. Tokenize
        tokens = self._tokenize(text + " " + title)
        
        # 3. Normalize (lowercase, stem/lemmatize)
        normalized = [self._normalize(t) for t in tokens]
        
        # 4. Remove stop words ("the", "a", "is", etc.)
        filtered = [t for t in normalized if t not in self.STOP_WORDS]
        
        # 5. Compute TF for each unique term
        tf_map = {}
        for position, term in enumerate(filtered):
            if term not in tf_map:
                tf_map[term] = {"count": 0, "positions": []}
            tf_map[term]["count"] += 1
            tf_map[term]["positions"].append(position)
        
        # 6. Emit index entries
        entries = []
        for term, info in tf_map.items():
            entries.append({
                "term": term,
                "doc_id": doc_id,
                "tf": info["count"] / len(filtered),  # Normalized TF
                "positions": info["positions"],
                "is_title": term in self._tokenize(title),
            })
        
        return entries
    
    def _normalize(self, word: str) -> str:
        """Lowercase + stemming (Porter stemmer)."""
        word = word.lower()
        # Simple suffix stripping (real stemmer is more complex)
        for suffix in ["ing", "tion", "ness", "ment", "er", "ed", "s"]:
            if word.endswith(suffix) and len(word) - len(suffix) > 3:
                return word[:-len(suffix)]
        return word
    
    def _tokenize(self, text: str) -> list:
        """Split on non-alphanumeric characters."""
        import re
        return re.findall(r'\b[a-zA-Z0-9]+\b', text)
    
    # Reduce phase: aggregate all (doc_id, info) for same term
    def merge_postings(self, term: str, postings: list) -> dict:
        """
        Merge all postings for a term.
        Sort by relevance score for efficient top-K retrieval.
        """
        # Sort by TF-IDF score descending
        idf = self._compute_idf(term, postings)
        
        for posting in postings:
            posting["tf_idf"] = posting["tf"] * idf
            posting["score"] = self._compute_bm25(posting, idf)
        
        postings.sort(key=lambda p: p["score"], reverse=True)
        
        return {
            "term": term,
            "doc_count": len(postings),
            "idf": idf,
            "postings": postings  # Sorted by relevance
        }
    
    def _compute_idf(self, term: str, postings: list) -> float:
        """
        IDF = log(N / df) where N = total docs, df = docs containing term
        
        Rare terms have high IDF (more discriminative)
        Common terms ("the", "is") have low IDF (less useful for ranking)
        """
        import math
        N = self.total_docs
        df = len(postings)
        return math.log((N - df + 0.5) / (df + 0.5) + 1)
```

---

## 6) BM25 Ranking

```python
import math

def bm25_score(term_freq: float, doc_length: int, avg_doc_length: float,
               idf: float, k1: float = 1.2, b: float = 0.75) -> float:
    """
    BM25 (Best Match 25): the industry-standard ranking formula.
    Used by Elasticsearch, Solr, Lucene.
    
    Parameters:
    - tf: term frequency in this document
    - doc_length: number of tokens in document
    - avg_doc_length: average tokens across all documents
    - idf: inverse document frequency for this term
    - k1: controls saturation of term frequency (1.2 = standard)
    - b: controls document length normalization (0.75 = standard)
    
    Intuition:
    - Higher TF in short doc = more relevant (not just a longer doc)
    - Rare term in many docs = not very discriminative
    - Logarithm on IDF = prevents one rare term dominating everything
    """
    # Length normalization factor
    norm = 1 - b + b * (doc_length / avg_doc_length)
    
    # TF with saturation (diminishing returns beyond k1 occurrences)
    tf_normalized = (term_freq * (k1 + 1)) / (term_freq + k1 * norm)
    
    return idf * tf_normalized

# Multi-term query scoring:
def score_document(query_terms: list, doc: dict, index: dict) -> float:
    """
    Sum BM25 scores for each query term independently.
    Query "quick fox" -> score(quick, doc) + score(fox, doc)
    """
    total_score = 0.0
    
    for term in query_terms:
        if term in index and doc["id"] in index[term]["postings_map"]:
            posting = index[term]["postings_map"][doc["id"]]
            idf = index[term]["idf"]
            tf = posting["tf"]
            
            term_score = bm25_score(
                term_freq=tf,
                doc_length=doc["length"],
                avg_doc_length=index["_meta"]["avg_doc_length"],
                idf=idf
            )
            
            # Boost for title match
            if posting.get("is_title"):
                term_score *= 2.0
            
            total_score += term_score
    
    return total_score
```

---

## 7) Web Crawling System

```python
class WebCrawler:
    """
    Distributed web crawler.
    Goal: crawl 6B pages/day = 69,000 pages/second.
    Requires: hundreds of crawler workers in parallel.
    """
    
    def __init__(self, seed_urls: list):
        self.frontier = CrawlFrontier()    # URL queue with priority
        self.seen_urls = BloomFilter(capacity=100_000_000_000)  # 100B URLs
        self.robots_cache = {}             # domain -> robots.txt rules
        
        # Seed initial URLs
        for url in seed_urls:
            self.frontier.add(url, priority=1.0)
    
    async def crawl_worker(self) -> None:
        """
        One crawler worker. Run hundreds of these in parallel.
        """
        while True:
            # Get next URL to crawl (priority queue: PageRank-ordered)
            url, priority = await self.frontier.pop()
            
            if not url:
                await asyncio.sleep(1)
                continue
            
            # Check robots.txt (respect crawl rules)
            if not await self._is_allowed(url):
                continue
            
            # Fetch page
            try:
                response = await self.http_client.get(
                    url,
                    timeout=10,
                    max_redirects=5,
                    user_agent="Googlebot/2.1 (+http://www.google.com/bot.html)"
                )
            except Exception:
                continue
            
            # Parse and extract
            links = self._extract_links(url, response.text)
            content_hash = hashlib.md5(response.text.encode()).hexdigest()
            
            # Skip if content unchanged (use If-Modified-Since or ETag)
            if not await self._is_changed(url, content_hash):
                await self.frontier.schedule_recrawl(url, delay_hours=24)
                continue
            
            # Send to indexing pipeline
            await self.indexing_queue.put({
                "url": url,
                "html": response.text,
                "fetched_at": datetime.utcnow().isoformat(),
                "content_hash": content_hash
            })
            
            # Add new links to frontier
            for link in links:
                if link not in self.seen_urls:
                    self.seen_urls.add(link)
                    priority = await self._estimate_priority(link)
                    await self.frontier.add(link, priority)
    
    def _extract_links(self, base_url: str, html: str) -> list:
        """Extract and normalize all links from a page."""
        from urllib.parse import urljoin, urlparse
        from bs4 import BeautifulSoup
        
        soup = BeautifulSoup(html, "html.parser")
        links = []
        
        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"]
            # Resolve relative URLs
            absolute = urljoin(base_url, href)
            parsed = urlparse(absolute)
            
            # Only HTTP/HTTPS links
            if parsed.scheme in ("http", "https"):
                links.append(absolute)
        
        return list(set(links))  # Deduplicate
    
    async def _estimate_priority(self, url: str) -> float:
        """
        Higher priority = crawl sooner.
        Factors: link count to this URL (PageRank signal), domain authority.
        """
        domain = urlparse(url).netloc
        
        domain_rank = await self.domain_rank.get(domain, default=0.5)
        inlink_count = await self.link_graph.count_inlinks(url)
        
        return domain_rank * 0.7 + min(1.0, inlink_count / 1000) * 0.3
```

### Crawl frontier (priority queue)
```python
class CrawlFrontier:
    """
    URL priority queue.
    High-priority URLs (popular pages) crawled more frequently.
    
    Implementation: Redis sorted set per domain
    (Each domain has its own queue to enforce politeness - don't hammer one host)
    """
    
    MIN_CRAWL_DELAY_S = 1.0   # Wait 1 second between requests to same domain
    
    async def pop(self) -> tuple:
        # Get highest-priority URL across all active domain queues
        domain = await self._get_next_available_domain()
        if not domain:
            return None, 0
        
        url, priority = await self.redis.zpopmax(f"frontier:{domain}")
        
        # Enforce politeness delay
        await self.redis.setex(f"last_crawl:{domain}", int(self.MIN_CRAWL_DELAY_S), "1")
        
        return url, priority
    
    async def add(self, url: str, priority: float) -> None:
        domain = urlparse(url).netloc
        await self.redis.zadd(f"frontier:{domain}", {url: priority})
    
    async def _get_next_available_domain(self) -> str | None:
        """Get a domain that isn't in cooldown period."""
        active_domains = await self.redis.smembers("active_domains")
        
        for domain in active_domains:
            is_cooling = await self.redis.exists(f"last_crawl:{domain}")
            if not is_cooling and await self.redis.zcard(f"frontier:{domain}") > 0:
                return domain
        
        return None
```

---

## 8) Query Processing and Retrieval

```python
class SearchEngine:
    """
    Query processing: tokenize query, look up inverted index, rank results.
    Must complete in < 200ms for P99.
    """
    
    async def search(self, query: str, user_id: str = None, page: int = 1) -> dict:
        """
        Full search pipeline:
        1. Query understanding (spell check, expansion)
        2. Document retrieval from inverted index
        3. Ranking (BM25 + PageRank + freshness + personalization)
        4. Snippet generation
        """
        # Step 1: Understand query
        processed_query = await self.query_processor.process(query)
        
        # Step 2: Check result cache (30-second TTL for popular queries)
        cache_key = f"search:{processed_query['normalized']}"
        cached = await self.redis.get(cache_key)
        if cached and not user_id:  # Don't serve cached for personalized searches
            return json.loads(cached)
        
        # Step 3: Retrieve candidate documents
        candidates = await self._retrieve_candidates(processed_query)
        
        # Step 4: Score and rank
        ranked = await self._rank_documents(candidates, processed_query, user_id)
        
        # Step 5: Paginate
        offset = (page - 1) * 10
        page_results = ranked[offset:offset + 10]
        
        # Step 6: Generate snippets
        results = await self._generate_snippets(page_results, processed_query)
        
        response = {
            "query": query,
            "total_results": len(ranked),
            "results": results,
            "did_you_mean": processed_query.get("spell_correction"),
            "query_time_ms": ...
        }
        
        # Cache non-personalized results
        if not user_id:
            await self.redis.setex(cache_key, 30, json.dumps(response))
        
        return response
    
    async def _retrieve_candidates(self, query: dict) -> list:
        """
        Use inverted index to find all documents containing query terms.
        
        For multi-word queries: use AND (intersection) for must-match terms
        For optional terms: use OR (union) + scoring
        """
        query_terms = query["terms"]
        
        # Look up each term in parallel
        postings_lists = await asyncio.gather(*[
            self.index.get_postings(term) for term in query_terms
        ])
        
        # Phrase query: require terms to be adjacent in document
        if query.get("is_phrase"):
            return self._intersect_postings_with_proximity(
                query_terms, postings_lists
            )
        
        # AND query: intersection of all postings lists
        # Start with rarest term (shortest list) for efficiency
        sorted_postings = sorted(
            zip(query_terms, postings_lists),
            key=lambda x: len(x[1]) if x[1] else 0
        )
        
        if not sorted_postings[0][1]:
            return []
        
        candidate_set = {p["doc_id"] for p in sorted_postings[0][1]}
        
        for term, postings in sorted_postings[1:]:
            if not postings:
                return []
            candidate_set &= {p["doc_id"] for p in postings}
        
        return list(candidate_set)
```

---

## 9) PageRank (Link Analysis)

```python
def pagerank(graph: dict, damping: float = 0.85, iterations: int = 100) -> dict:
    """
    PageRank: rank pages by number and quality of links pointing to them.
    
    Intuition: A page is important if many important pages link to it.
    Like academic citations: a paper is valuable if cited by valuable papers.
    
    Formula: PR(A) = (1-d)/N + d * sum(PR(Ti)/C(Ti) for each Ti that links to A)
    Where:
    - d = damping factor (0.85 = standard)
    - N = total pages
    - Ti = pages linking to A
    - C(Ti) = number of outlinks from Ti
    """
    N = len(graph)
    ranks = {page: 1.0 / N for page in graph}
    
    for _ in range(iterations):
        new_ranks = {}
        for page in graph:
            # Sum of PR contributions from all pages linking to this page
            rank_sum = sum(
                ranks[source] / len(graph[source])
                for source in graph
                if page in graph[source]  # source links to page
            )
            new_ranks[page] = (1 - damping) / N + damping * rank_sum
        
        ranks = new_ranks
    
    return dict(sorted(ranks.items(), key=lambda x: x[1], reverse=True))

# Simple example:
web = {
    "google.com":     ["wikipedia.org", "github.com"],
    "wikipedia.org":  ["google.com"],
    "github.com":     ["google.com", "wikipedia.org"],
    "spam-site.com":  ["google.com"],  # Low quality
}
pr = pagerank(web)
# google.com and wikipedia.org will have highest PageRank
# spam-site.com will have very low PR (no one links to it)
print(pr)
```

---

## 10) Autocomplete and Spell Correction

```python
class AutocompleteService:
    """
    Suggest query completions as user types.
    Must be extremely fast: < 50ms P99.
    
    Two approaches:
    1. Trie: prefix tree for exact prefix matching
    2. Ranked completion cache: precompute top completions for popular prefixes
    """
    
    def __init__(self, redis_client):
        self.redis = redis_client
    
    async def get_suggestions(self, prefix: str, limit: int = 10) -> list:
        """
        Get top completions for a prefix.
        Uses Redis sorted set: score = query frequency (higher = more popular).
        """
        prefix = prefix.lower().strip()
        
        if len(prefix) < 2:
            return []
        
        # Redis sorted set: all queries starting with prefix
        # Use ZRANGEBYLEX to get alphabetically ordered results,
        # then sort by frequency (pre-computed scores)
        
        # Approach: Store "query:prefix:2" -> sorted set of completions
        cache_key = f"autocomplete:{prefix}"
        results = await self.redis.zrevrange(cache_key, 0, limit - 1, withscores=True)
        
        if results:
            return [{"query": r[0], "frequency": int(r[1])} for r in results]
        
        # Cache miss: query from Elasticsearch/Trie index
        suggestions = await self.suggestion_index.complete(prefix, limit)
        
        # Cache for 5 minutes
        if suggestions:
            pipe = self.redis.pipeline()
            for s in suggestions:
                pipe.zadd(cache_key, {s["query"]: s["frequency"]})
            pipe.expire(cache_key, 300)
            await pipe.execute()
        
        return suggestions


class SpellCorrector:
    """
    "Did you mean...?" for misspelled queries.
    Uses edit distance + query frequency.
    """
    
    def suggest_correction(self, query: str) -> str | None:
        words = query.lower().split()
        corrected_words = []
        
        for word in words:
            if word in self.vocabulary:
                corrected_words.append(word)
            else:
                # Find closest word in vocabulary by edit distance
                candidates = self._get_candidates(word)
                if candidates:
                    best = max(candidates, key=lambda w: self.word_frequency.get(w, 0))
                    corrected_words.append(best)
                else:
                    corrected_words.append(word)
        
        corrected = " ".join(corrected_words)
        return corrected if corrected != query else None
    
    def _get_candidates(self, word: str, max_edit_distance: int = 2) -> list:
        """Words within edit distance 1 or 2."""
        candidates = set()
        
        for vocab_word in self.vocabulary:
            if abs(len(word) - len(vocab_word)) <= max_edit_distance:
                dist = self._edit_distance(word, vocab_word)
                if dist <= max_edit_distance:
                    candidates.add(vocab_word)
        
        return list(candidates)
```

---

## 11) HLD

```text
[Web]
 |
 v
[Crawler Fleet] -----> [Crawl Queue (Kafka)] -----> [Content Store (S3)]
(thousands of           (URL dedup, priority)         (raw HTML)
 async workers)                                         |
                                                        v
                                                  [Index Pipeline]
                                                  (MapReduce/Spark)
                                                        |
                                                        v
                                                  [Inverted Index]
                                                  (sharded, distributed)
                                                        |
                                                        +---------> [CDN?]
                                                                    (no - queries are personalized)
User Query
    |
    v
[Query Service / Search API]
    |
    +---[Query Processor]    <- Spell check, entity recognition, expansion
    +---[Index Lookup]       <- Inverted index lookup (distributed)
    +---[Ranker]             <- BM25 + PageRank + ML ranking signals
    +---[Snippet Generator]  <- Extract relevant text excerpt
    +---[Result Cache]       <- Cache popular queries (30s TTL)
    |
    v
Results returned to user
```

---

## 12) Interview Strategy

### Opening
```text
"A search engine has three components: crawling (data ingestion), 
indexing (data structure), and serving (retrieval + ranking).

The core data structure is the inverted index: word → list of documents.
The core challenge is scale: 60 trillion pages, 8.5B queries/day, P99 < 200ms.

I'll focus on: inverted index sharding, BM25+PageRank ranking, 
distributed crawling with politeness, and query serving with caching."
```

### Key decisions
```text
1. How do you shard the inverted index?
   Two options:
   A. Document-partitioned: each shard holds all words for subset of docs
      -> Query must hit all shards, merge results (expensive)
   B. Term-partitioned: each shard holds subset of vocabulary (all docs for "fox")
      -> Query hits only shards for those terms (efficient)
   
   Reality: Document-partitioned used in practice (simpler fault tolerance).
   Each query fans out to all shards, each returns top-K, merge and re-rank.

2. How do you keep the index fresh?
   Two update mechanisms:
   - Near-realtime: breaking news -> priority crawl + incremental index update
   - Batch: full recrawl of slow-changing content (weekly)
   
   Separate "fresh" index for news (minutes) from "stable" index (days-weeks).
   Serve merged results.

3. How do you prevent malicious/spam content from ranking highly?
   - Link graph analysis: spam sites have unusual link patterns
   - Content quality signals: bounce rate, dwell time
   - Algorithmic spam filters (Panda-like) penalize low-quality content
   - Manual spam reports + quality rater feedback

4. How does personalization work?
   - Non-logged-in: no personalization
   - Logged-in: user's past search/click history → adjust ranking scores
   - Privacy: aggregated signals, not raw history used in real-time
```
