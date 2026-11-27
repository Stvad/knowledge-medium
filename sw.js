(function() {
	// src/sw/assets.ts
	/**
	* Which same-origin runtime assets the service worker serves cache-first from
	* the generation cache. Kept globals-free (primitives in, boolean out — no
	* `Request`/`URL`/worker types) so it imports cleanly into BOTH the WebWorker
	* tsconfig (the worker, src/sw/sw.ts) and the Node scripts tsconfig
	* (scripts/precache-assets.ts), and unit-tests without mocking `Request`.
	*
	* `ASSET_EXTENSION` is the load-bearing shared constant. The build precaches by
	* extension; the SW ALSO serves cache-first by `request.destination` (below), so
	* strictly the served set is a superset of the precached set. That superset is
	* empty in practice — every emitted dist asset carries a recognized extension,
	* so a destination-matched request always also matches by extension and was
	* precached. Importing the ONE extension definition here (instead of duplicating
	* the literal in the build script and diffing it in a test) keeps the two in
	* lockstep on the axis the precache is actually built from; the invariant that
	* closes the gap is "every served asset has a recognized extension", which holds
	* for our own emitted output.
	*/
	var ASSET_EXTENSION = /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico)$/;
	var ASSET_DESTINATIONS = /* @__PURE__ */ new Set([
		"script",
		"style",
		"worker",
		"font",
		"image"
	]);
	/**
	* True for a same-origin request the SW serves cache-first within the
	* generation. Match by `request.destination` first (covers the common cases a
	* browser labels) with an extension fallback for anything left as an empty
	* destination.
	*/
	var isCacheableAsset = (destination, pathname, sameOrigin) => sameOrigin && (ASSET_DESTINATIONS.has(destination) || ASSET_EXTENSION.test(pathname));
	/**
	* The fingerprint the build stamps for each precached file and the worker
	* recomputes over the bytes it fetched: hex SHA-256 cut to 64 bits, enough to
	* tell two builds' bytes apart. The one definition both sides use.
	*/
	var contentDigest = async (bytes) => {
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
	};
	// src/data/dbFileSiblings.ts
	/** `OPFSWriteAheadVFS`'s write-ahead log — two files, alternated WAL2-style. */
	var WRITE_AHEAD_SIDECAR_SUFFIXES = ["-wa0", "-wa1"];
	/**
	* SQLite's own crash-recovery files. These must be removed BEFORE the main
	* `.db`: left beside a fresh database of the same name, SQLite replays them.
	*
	* Wider than what this app produces, deliberately: deletion should clear
	* anything SQLite could replay, whoever wrote it. Restoring is the opposite and
	* uses a narrower whitelist — see `exportSqliteDb`.
	*/
	var SQLITE_JOURNAL_SUFFIXES = [
		"-journal",
		"-wal",
		"-shm"
	];
	[...SQLITE_JOURNAL_SUFFIXES, ...WRITE_AHEAD_SIDECAR_SUFFIXES];
	// src/sw/preview.ts
	/**
	* PR-preview subtree gating. github.io is ONE origin for production
	* (…/knowledge-medium/) AND every PR preview (…/pr-preview/pr-<n>/…). A
	* production/root SW's scope is a PREFIX of every preview path, and since we
	* never `clients.claim()`, the production SW controls a freshly-opened preview
	* page until it reloads — and would otherwise cache the preview's shell +
	* assets under production's OWN keys, poisoning the offline production shell
	* with an unmerged build. So a SW refuses to serve/cache a preview subtree it
	* doesn't own. A preview's own SW (its scope IS under /pr-preview/) is exempt.
	*
	* Globals-free (a regex + a pure predicate over primitives) so it's unit-tested
	* directly and shared without dragging worker types.
	*/
	var PREVIEW_SUBTREE = /\/pr-preview\/pr-[^/]+\//;
	/**
	* True when this SW must NOT touch a request: the request targets a preview
	* subtree that this scope does not own. A preview-scoped SW (its own scope is
	* under /pr-preview/) owns its subtree, so it's never "foreign" to itself.
	*/
	var isForeignPreviewRequest = (ownScopeIsPreview, pathname) => !ownScopeIsPreview && PREVIEW_SUBTREE.test(pathname);
	// src/sw/ledger.ts
	/**
	* Pure decisions over the generation ledger — an install-ordered list of
	* BUILD_IDs (newest last). The worker (src/sw/worker.ts) owns the impure I/O
	* (reading/writing the ledger Response in the meta cache); the retention math
	* lives here so it unit-tests without a cache.
	*
	* Each deploy is an immutable generation with its own km-shell-<id> /
	* km-assets-<id> caches. On activate we keep the most recent `keep`
	* generations (so a tab still on a prior build has a consistent cache to read
	* from) and GC the rest.
	*/
	/** The ids to KEEP: the most recent `keep`, newest-last order preserved. */
	var computeKeepIds = (ledger, keep) => ledger.slice(Math.max(0, ledger.length - keep));
	/**
	* The ids that have aged out of the keep-window and whose caches should be
	* GC'd. Disjoint from computeKeepIds; empty when the ledger fits the window.
	*/
	var computeExpiredIds = (ledger, keep) => ledger.slice(0, Math.max(0, ledger.length - keep));
	/**
	* Normalize a stored ledger value into {ids, updatedAt}. Tolerates the two
	* on-disk shapes: the current {ids, updatedAt} object and the LEGACY bare array
	* (written before timestamps existed) — the latter has no timestamp, which the
	* sweeper reads as "staleness unprovable → never reap". Anything else (null,
	* garbage, non-array ids) degrades to an empty ledger.
	*/
	var normalizeLedger = (raw) => {
		if (Array.isArray(raw)) return {
			ids: raw,
			updatedAt: void 0
		};
		if (raw && typeof raw === "object" && Array.isArray(raw.ids)) {
			const { ids, updatedAt } = raw;
			return {
				ids,
				updatedAt: typeof updatedAt === "number" ? updatedAt : void 0
			};
		}
		return {
			ids: [],
			updatedAt: void 0
		};
	};
	/**
	* Decide which OTHER-scope generation caches a sweep should reclaim. Cache
	* Storage is shared per-origin, so a client accumulates the caches of every PR
	* preview it ever visited; once a PR is merged/closed its preview SW never runs
	* again to GC them, so they leak forever. This sweep (run from any active SW's
	* activate) reclaims them — but ONLY:
	*   - preview scopes (PREVIEW_SUBTREE matches the ledger key's path). Production
	*     is NEVER a preview scope, so it can never be reaped here — the sweep is
	*     structurally incapable of touching prod caches.
	*   - that are STALE: a numeric updatedAt older than staleMs. A legacy
	*     untimestamped ledger (updatedAt undefined) is never reaped — we can't
	*     prove it's abandoned. The current scope's own ledger was just re-stamped
	*     on install, so it's fresh and self-excluded.
	* A generation id still referenced by any KEPT (non-reaped) ledger is spared —
	* two deploys can in principle share a build sha, and we must not delete a cache
	* a live scope depends on. The stale ledger ENTRY is removed regardless (the
	* scope is gone), even when its cache was shared-protected.
	*/
	var computeReapableCaches = ({ ledgers, now, staleMs, selfScopeUrl }) => {
		const isPreviewScope = (scopeUrl) => {
			try {
				return PREVIEW_SUBTREE.test(new URL(scopeUrl).pathname);
			} catch {
				return false;
			}
		};
		const isStale = (l) => typeof l.updatedAt === "number" && now - l.updatedAt > staleMs;
		const reapable = ledgers.filter((l) => l.scopeUrl !== selfScopeUrl && isPreviewScope(l.scopeUrl) && isStale(l));
		const reapableSet = new Set(reapable);
		const keptIds = new Set(ledgers.filter((l) => !reapableSet.has(l)).flatMap((l) => l.ids));
		const reapIds = /* @__PURE__ */ new Set();
		for (const l of reapable) for (const id of l.ids) if (!keptIds.has(id)) reapIds.add(id);
		return {
			reapIds: [...reapIds],
			ledgerScopeUrls: reapable.map((l) => l.scopeUrl)
		};
	};
	// src/utils/idbKeyedStore.ts
	/** Promisify a single `IDBRequest` — resolve on success, reject on error. */
	var promisifyRequest = (request) => new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	/** Resolve when the transaction COMMITS (`oncomplete`), reject on abort/error.
	*  A readwrite write is only durable once the tx commits — `onsuccess` fires
	*  earlier, while the tx is still open — so a caller that navigates/reloads
	*  right after a write can have an un-committed tx rolled back. Handlers are
	*  registered synchronously by the caller (before any await) so an `oncomplete`
	*  that fires before we start awaiting can't be missed. */
	var txCommitted = (transaction) => new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction aborted"));
		transaction.onerror = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction error"));
	});
	/** Record-id prefix for all of an owner's records. The trailing `:` plus
	*  `encodeURIComponent` (which escapes any literal `:` to `%3A`) makes this an
	*  unambiguous, collision-free prefix — `enc("ab"):` is never a prefix of
	*  `enc("abc"):…`, so a `startsWith(prefix)` scan can't match a sibling owner. */
	var idbKeyPrefix = (owner) => `${encodeURIComponent(owner)}:`;
	/** Composite record id. Each segment is encoded so a delimiter inside an id
	*  can't make two distinct `(owner, id)` pairs collide. */
	var idbRecordId = (owner, id) => `${idbKeyPrefix(owner)}${encodeURIComponent(id)}`;
	/**
	* A cached connection to one named DB + one object store, with commit-durable
	* transactions. Each instance owns its own connection handle, so constructing a
	* fresh instance against the same DB models a page reload (a new tab/handle
	* reopening persisted data) — which is exactly how the consumers' tests verify
	* durability.
	*/
	var IdbKeyedStore = class {
		dbName;
		storeName;
		version;
		dbPromise = null;
		constructor(dbName, storeName, version = 1) {
			this.dbName = dbName;
			this.storeName = storeName;
			this.version = version;
		}
		openDb() {
			if (!this.dbPromise) {
				const opened = new Promise((resolve, reject) => {
					const request = indexedDB.open(this.dbName, this.version);
					request.onupgradeneeded = () => {
						const db = request.result;
						if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
					};
					request.onsuccess = () => {
						const db = request.result;
						db.onclose = () => {
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						db.onversionchange = () => {
							db.close();
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						resolve(db);
					};
					request.onerror = () => reject(request.error);
				}).catch((err) => {
					if (this.dbPromise === opened) this.dbPromise = null;
					throw err;
				});
				this.dbPromise = opened;
			}
			return this.dbPromise;
		}
		/**
		* Open a transaction and return its object store plus a commit fence. PRIVATE
		* and footgun-laden by design — the caller must issue its first request
		* synchronously and observe `committed` on EVERY path (await it, or `.catch` it
		* on an error path) or a tx abort surfaces as an unhandled rejection. The public
		* ops ({@link runTransaction}, {@link tx}, {@link scanByPrefix}) wrap exactly
		* that contract so callers never have to.
		*/
		async openTransaction(mode) {
			const transaction = (await this.openDb()).transaction(this.storeName, mode);
			const committed = txCommitted(transaction);
			return {
				store: transaction.objectStore(this.storeName),
				committed
			};
		}
		/**
		* Run `body` against the store within one transaction and resolve on the
		* transaction COMMIT (durability), not a request's `onsuccess`. `body` MUST
		* issue its first request synchronously — it is invoked in the same task that
		* created the tx (see the file header on activeness). If `body` rejects (or the
		* commit fence does), the fence's rejection is observed here so it can't surface
		* as an unhandled rejection, and the original error propagates. Use for cursor
		* scans / read-modify-write; single-request ops use {@link tx}.
		*/
		async runTransaction(mode, body) {
			const { store, committed } = await this.openTransaction(mode);
			try {
				const result = await body(store);
				await committed;
				return result;
			} catch (err) {
				committed.catch(() => {});
				throw err;
			}
		}
		/**
		* Run a single request against the store, resolving on the transaction COMMIT
		* (durability). The common case; multi-request / cursor work uses
		* {@link runTransaction}.
		*/
		async tx(mode, run) {
			return this.runTransaction(mode, (store) => promisifyRequest(run(store)));
		}
		/**
		* Walk every record whose key starts with `prefix` (the per-owner namespace
		* from {@link idbKeyPrefix}), calling `visit` with each matching cursor, in one
		* commit-durable transaction. A value cursor, because `visit` reads
		* `cursor.value`; the `:`-delimited prefix is collision-free across owners, so
		* a scan never reaches a sibling owner. `visit` is synchronous
		* (it runs in the cursor's `onsuccess`, while the tx is active) and may read
		* `cursor.value` or, in a `'readwrite'` scan, `cursor.delete()`; accumulate into
		* a variable it closes over. If `visit` throws, the scan aborts (rolling back a
		* readwrite scan's partial writes) and rejects with that error.
		*/
		async scanByPrefix(mode, prefix, visit) {
			await this.runTransaction(mode, (store) => new Promise((resolve, reject) => {
				const request = store.openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) {
						resolve();
						return;
					}
					try {
						if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) visit(cursor);
						cursor.continue();
					} catch (err) {
						try {
							store.transaction.abort();
						} catch {}
						reject(err);
					}
				};
				request.onerror = () => reject(request.error);
			}));
		}
		/**
		* Delete every record whose key starts with `prefix`, in one commit-durable
		* readwrite transaction. One ranged delete rather than a value cursor: a
		* cursor deserialises every record in the store to test its key, and some
		* stores hold multi-MB records. The range is exactly "starts with": every
		* key from `prefix` up to, excluding, the prefix with its last code unit
		* incremented.
		*/
		async deleteByPrefix(prefix) {
			const last = prefix.charCodeAt(prefix.length - 1);
			if (last === 65535) throw new Error("deleteByPrefix: the prefix has no successor");
			const upper = prefix.slice(0, -1) + String.fromCharCode(last + 1);
			await this.tx("readwrite", (store) => store.delete(IDBKeyRange.bound(prefix, upper, false, true)));
		}
	};
	// src/sw/bootStore.ts
	/**
	* The boot set (shell HTML, first-paint assets, vendor React) in IndexedDB, so
	* a cold launch answers them without touching Cache Storage. On iOS the first
	* Cache Storage call of a service-worker lifetime costs ~600 ms regardless of
	* which cache or how many entries (measured against an IndexedDB open in the
	* same worker: 17 ms); Cache Storage stays the store for everything lazy.
	*
	* Entries are keyed by build id, so a worker only ever serves its own
	* generation's bytes and the activate GC reaps a generation by prefix.
	*/
	var bootKeyPrefix = (buildId) => idbKeyPrefix(buildId);
	var bootKey = (buildId, url) => idbRecordId(buildId, url);
	var idbBootStore = () => {
		const store = new IdbKeyedStore("km-boot", "entries");
		return {
			get: (key) => store.tx("readonly", (s) => s.get(key)),
			putAll: (entries) => store.runTransaction("readwrite", async (s) => {
				for (const [key, entry] of entries) s.put(entry, key);
			}),
			deletePrefix: (prefix) => store.deleteByPrefix(prefix)
		};
	};
	// src/sw/previewDatabases.ts
	var SERVICE_WORKER_META_CACHE = "km-meta";
	var PREVIEW_DATABASE_RECORD_BASENAME = "__km_database__";
	var previewDatabaseRecordInfo = (recordUrl, ledgerBasename) => {
		try {
			const url = new URL(recordUrl);
			const marker = `/${PREVIEW_DATABASE_RECORD_BASENAME}/`;
			const markerIndex = url.pathname.indexOf(marker);
			if (markerIndex < 0) return null;
			const encodedName = url.pathname.slice(markerIndex + marker.length);
			if (!encodedName || encodedName.includes("/")) return null;
			const scopePath = url.pathname.slice(0, markerIndex + 1);
			return {
				scopeUrl: `${`${url.origin}${scopePath}`}${ledgerBasename}`,
				name: decodeURIComponent(encodedName)
			};
		} catch {
			return null;
		}
	};
	// src/sw/worker.ts
	/**
	* The service worker's orchestration — ledger I/O, install precache, activate
	* GC, and fetch routing — as a factory parameterized by its globals
	* (`caches` / `fetch` / origin) instead of reaching for `self`. The worker
	* entry (src/sw/sw.ts) constructs one of these with the real globals + injected
	* build config and wires it to the SW events; tests construct one with an
	* in-memory CacheStorage and a stub fetch and drive install/activate/fetch
	* directly. Keeping this file free of `self` / ServiceWorkerGlobalScope is what
	* makes it importable + unit-testable outside a worker.
	*
	* The versioning model this implements is documented in the sw.ts header.
	*/
	var CACHE_PREFIX = "km-";
	var VENDOR_HOSTS = /* @__PURE__ */ new Set(["esm.sh"]);
	var createServiceWorker = (config, env) => {
		const { buildId, scopeURL, keepGenerations } = config;
		const { caches, fetch, now } = env;
		const SHELL_CACHE = `${CACHE_PREFIX}shell-${buildId}`;
		const ASSET_CACHE = `${CACHE_PREFIX}assets-${buildId}`;
		const VENDOR_CACHE = `${CACHE_PREFIX}vendor`;
		const META_CACHE = SERVICE_WORKER_META_CACHE;
		const toScopeUrl = (p) => new URL(p, scopeURL).toString();
		const resolveManifest = (manifest) => Object.entries(manifest).map(([path, digest]) => [toScopeUrl(path), digest]);
		const SHELL_ENTRIES = resolveManifest(config.precacheShell);
		const PRECACHE_ENTRIES = resolveManifest(config.precacheAssets);
		const PRECACHE_REST_ENTRIES = resolveManifest(config.precacheRestAssets);
		const PRECACHE_ASSETS = PRECACHE_ENTRIES.map(([url]) => url);
		const SHELL_URL = toScopeUrl("./index.html");
		const BOOT_SET = [[SHELL_CACHE, [SHELL_URL]], [ASSET_CACHE, PRECACHE_ASSETS]];
		const BOOT_URLS = new Set(BOOT_SET.flatMap(([, urls]) => urls));
		const deleteGeneration = (id) => [
			caches.delete(`${CACHE_PREFIX}shell-${id}`),
			caches.delete(`${CACHE_PREFIX}assets-${id}`),
			env.bootStore?.deletePrefix(bootKeyPrefix(id)).catch(() => void 0)
		];
		const OWN_SCOPE_IS_PREVIEW = PREVIEW_SUBTREE.test(scopeURL.pathname);
		const LEDGER_BASENAME = "__km_generations__";
		const LEDGER_KEY = toScopeUrl(`./${LEDGER_BASENAME}`);
		const readLedgerEntry = async () => {
			try {
				const res = await (await caches.open(META_CACHE)).match(LEDGER_KEY);
				if (!res) return {
					ids: [],
					updatedAt: void 0
				};
				return normalizeLedger(await res.json());
			} catch {
				return {
					ids: [],
					updatedAt: void 0
				};
			}
		};
		const readLedger = async () => (await readLedgerEntry()).ids;
		const writeLedgerEntry = async (entry) => {
			const cache = await caches.open(META_CACHE);
			const nextEntry = {
				...entry,
				updatedAt: now()
			};
			await cache.put(LEDGER_KEY, new Response(JSON.stringify(nextEntry), { headers: { "content-type": "application/json" } }));
		};
		let ledgerMutationChain = Promise.resolve();
		const mutateLedgerEntry = async (mutate) => {
			const run = ledgerMutationChain.then(async () => {
				const entry = await readLedgerEntry();
				await writeLedgerEntry(await mutate(entry));
			});
			ledgerMutationChain = run.catch(() => {});
			await run;
		};
		const recordGeneration = async (id) => {
			await mutateLedgerEntry((entry) => {
				const ids = entry.ids.filter((x) => x !== id);
				ids.push(id);
				return {
					...entry,
					ids
				};
			});
		};
		const forgetGeneration = async (id) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: entry.ids.filter((x) => x !== id)
			}));
		};
		const writeLedger = async (ids) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids
			}));
		};
		const trimLedger = async () => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: computeKeepIds(entry.ids, keepGenerations)
			}));
		};
		let lastTouchAt = 0;
		const maybeTouchOwnLedger = (waitUntil) => {
			if (!OWN_SCOPE_IS_PREVIEW) return;
			const t = now();
			if (t - lastTouchAt <= config.touchIntervalMs) return;
			lastTouchAt = t;
			const touch = (async () => {
				try {
					await mutateLedgerEntry((entry) => entry);
				} catch {}
			})();
			if (waitUntil) waitUntil(touch);
		};
		const install = async () => {
			try {
				await precache();
			} catch (err) {
				await Promise.allSettled(deleteGeneration(buildId));
				await forgetGeneration(buildId).catch(() => {});
				throw err;
			}
		};
		const precache = async () => {
			await recordGeneration(buildId);
			const [shell, assets] = await Promise.all([caches.open(SHELL_CACHE), caches.open(ASSET_CACHE)]);
			const fetchInto = async (cache, url, digest, mode) => {
				const res = await fetch(new Request(url, { cache: mode })).catch(() => null);
				if (!res || !res.ok) return;
				const body = await res.clone().arrayBuffer().catch(() => null);
				if (!body) return;
				if (await contentDigest(body) !== digest) throw new Error(`[sw] ${url} differs from build ${buildId}'s copy; another deploy is being served`);
				await cache.put(url, res).catch(() => {});
			};
			const runPooled = async (entries, limit, task) => {
				let next = 0;
				let failure;
				const worker = async () => {
					while (!failure && next < entries.length) {
						const [url, digest] = entries[next++];
						try {
							await task(url, digest);
						} catch (err) {
							failure ??= { err };
						}
					}
				};
				await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
				if (failure) throw failure.err;
			};
			await runPooled(SHELL_ENTRIES, SHELL_ENTRIES.length, (u, d) => fetchInto(shell, u, d, "reload"));
			await runPooled(PRECACHE_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
			await seedBootStore();
			await runPooled(PRECACHE_REST_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
		};
		const seedBootStore = async () => {
			const store = env.bootStore;
			if (!store) return;
			try {
				for (const [cacheName, urls] of BOOT_SET) {
					const cache = await caches.open(cacheName);
					const entries = [];
					for (const url of urls) {
						const cached = await cache.match(url);
						if (!cached) continue;
						entries.push([bootKey(buildId, url), {
							status: cached.status,
							contentType: cached.headers.get("content-type") ?? "application/octet-stream",
							body: await cached.arrayBuffer()
						}]);
					}
					await store.putAll(entries);
				}
			} catch {}
		};
		const bootStoreFirst = async (url, fallback) => {
			const store = env.bootStore;
			if (store && BOOT_URLS.has(url)) try {
				const entry = await store.get(bootKey(buildId, url));
				if (entry) {
					env.mark?.("bootStoreHitAt");
					return new Response(entry.body, {
						status: entry.status,
						headers: { "content-type": entry.contentType }
					});
				}
			} catch {}
			return fallback();
		};
		const activate = async () => {
			const ledger = await readLedger();
			const keepIds = new Set(computeKeepIds(ledger, keepGenerations));
			const expiredIds = computeExpiredIds(ledger, keepGenerations);
			await Promise.all(expiredIds.flatMap(deleteGeneration));
			if (ledger.length > keepIds.size) try {
				await trimLedger();
			} catch {}
			try {
				await sweepStalePreviewGenerations();
			} catch {}
		};
		const sweepStalePreviewGenerations = async () => {
			const meta = await caches.open(META_CACHE);
			const ledgers = [];
			const databaseRecords = [];
			for (const req of await meta.keys()) {
				if (req.url.endsWith(`/${LEDGER_BASENAME}`)) {
					const res = await meta.match(req);
					if (!res) continue;
					const { ids, updatedAt } = normalizeLedger(await res.json().catch(() => null));
					ledgers.push({
						scopeUrl: req.url,
						ids,
						updatedAt
					});
					continue;
				}
				const recordInfo = previewDatabaseRecordInfo(req.url, LEDGER_BASENAME);
				if (recordInfo) {
					const res = await meta.match(req);
					const raw = res ? await res.json().catch(() => null) : null;
					databaseRecords.push({
						...recordInfo,
						recordUrl: req.url,
						updatedAt: databaseRecordUpdatedAt(raw)
					});
				}
			}
			const sweepNow = now();
			const plan = computeReapableCaches({
				ledgers,
				now: sweepNow,
				staleMs: config.staleScopeMs,
				selfScopeUrl: LEDGER_KEY
			});
			await Promise.all([
				sweepStalePreviewDatabases(meta, {
					ledgerScopeUrls: plan.ledgerScopeUrls,
					knownLedgerScopeUrls: ledgers.map(({ scopeUrl }) => scopeUrl),
					databaseRecords,
					sweepNow,
					staleMs: config.staleScopeMs
				}),
				...plan.reapIds.flatMap(deleteGeneration),
				...plan.ledgerScopeUrls.map((url) => meta.delete(url))
			]);
		};
		const databaseRecordUpdatedAt = (raw) => {
			if (!raw || typeof raw !== "object") return void 0;
			const { updatedAt } = raw;
			return typeof updatedAt === "number" ? updatedAt : void 0;
		};
		const previewIdForScopeUrl = (scopeUrl) => {
			try {
				return new URL(scopeUrl).pathname.match(/\/pr-preview\/(pr-[^/]+)\//)?.[1] ?? null;
			} catch {
				return null;
			}
		};
		const isDatabaseNameForPreviewScope = (databaseName, scopeUrl) => {
			const previewId = previewIdForScopeUrl(scopeUrl);
			if (!previewId) return false;
			const escapedPreviewId = previewId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`^kmp-v\\d+~${escapedPreviewId}~[A-Za-z0-9_-]*\\.db$`).test(databaseName);
		};
		const databaseRecordsToSweep = (ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs) => {
			const reapedScopes = new Set(ledgerScopeUrls);
			const knownScopes = new Set(knownLedgerScopeUrls);
			const records = [];
			const seen = /* @__PURE__ */ new Set();
			for (const record of databaseRecords) {
				const orphanedStaleRecord = typeof record.updatedAt === "number" && sweepNow - record.updatedAt > staleMs && !knownScopes.has(record.scopeUrl);
				if (!reapedScopes.has(record.scopeUrl) && !orphanedStaleRecord) continue;
				if (!isDatabaseNameForPreviewScope(record.name, record.scopeUrl)) continue;
				const key = `${record.scopeUrl}\n${record.name}`;
				if (seen.has(key)) continue;
				seen.add(key);
				records.push(record);
			}
			return records;
		};
		const sweepStalePreviewDatabases = async (meta, { ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs }) => {
			const databases = databaseRecordsToSweep(ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs);
			await Promise.all(databases.map(async ({ name, recordUrl }) => {
				try {
					await deleteOpfsSqliteDatabase(name);
					await deleteIndexedDatabase(name).catch(() => {});
				} catch {
					return;
				}
				await meta.delete(recordUrl).catch(() => false);
			}));
		};
		const deleteOpfsSqliteDatabase = async (databaseName) => {
			if (typeof env.storage?.getDirectory !== "function") return;
			const root = await env.storage.getDirectory();
			const journalFailure = (await Promise.allSettled(SQLITE_JOURNAL_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)))).find((result) => result.status === "rejected");
			if (journalFailure) throw journalFailure.reason;
			await removeOpfsEntryIfExists(root, databaseName);
			await Promise.allSettled(WRITE_AHEAD_SIDECAR_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)));
		};
		const removeOpfsEntryIfExists = async (root, name) => {
			try {
				await root.removeEntry(name);
			} catch (err) {
				if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
			}
		};
		const deleteIndexedDatabase = async (databaseName) => {
			const idb = env.indexedDB;
			if (typeof idb?.deleteDatabase !== "function") return;
			if (typeof idb.databases === "function") {
				const existing = await idb.databases().catch(() => null);
				if (existing && !existing.some((db) => db.name === databaseName)) return;
			}
			await new Promise((resolve, reject) => {
				const request = idb.deleteDatabase(databaseName);
				let settled = false;
				const settle = (fn) => {
					if (settled) return;
					settled = true;
					fn();
				};
				request.onsuccess = () => settle(resolve);
				request.onerror = () => settle(() => reject(request.error));
				request.onblocked = () => settle(() => reject(/* @__PURE__ */ new Error(`IndexedDB delete blocked for ${databaseName}`)));
			});
		};
		const isNavigationRequest = (request) => request.mode === "navigate" || request.method === "GET" && (request.headers.get("accept")?.includes("text/html") ?? false);
		const isSameOrigin = (url) => url.origin === env.origin;
		const isVendor = (url) => VENDOR_HOSTS.has(url.hostname);
		const shellCacheFirst = async (request, shellURL) => {
			const cache = await caches.open(SHELL_CACHE);
			env.mark?.("shellCacheOpenedAt");
			const cached = await cache.match(shellURL);
			env.mark?.("shellCacheMatchedAt");
			if (cached) return cached;
			const fresh = await fetch(request);
			if (fresh && fresh.ok) cache.put(shellURL, fresh.clone()).catch(() => {});
			return fresh;
		};
		const assetCacheFirst = async (request) => {
			const assets = await caches.open(ASSET_CACHE);
			const cached = await assets.match(request) || await (await caches.open(SHELL_CACHE)).match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) assets.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		const cacheFirst = async (request, cacheName) => {
			const cache = await caches.open(cacheName);
			const cached = await cache.match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		/**
		* Route a GET request. Returns a Response promise for the entry to
		* `respondWith`, or undefined to NOT intercept (let the browser handle it —
		* non-GET, non-http(s), foreign preview subtree, and same-origin non-assets
		* like version.json that must stay fresh).
		*/
		const handleFetch = (request, waitUntil) => {
			if (request.method !== "GET") return void 0;
			const url = new URL(request.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
			maybeTouchOwnLedger(waitUntil);
			if (isForeignPreviewRequest(OWN_SCOPE_IS_PREVIEW, url.pathname)) return void 0;
			if (isNavigationRequest(request) && isSameOrigin(url)) {
				if (url.pathname === scopeURL.pathname || url.href.split(/[?#]/)[0] === SHELL_URL) return bootStoreFirst(SHELL_URL, () => shellCacheFirst(request, SHELL_URL));
				return shellCacheFirst(request, SHELL_URL);
			}
			if (isCacheableAsset(request.destination, url.pathname, isSameOrigin(url))) return bootStoreFirst(request.url, () => assetCacheFirst(request));
			if (isVendor(url)) return cacheFirst(request, VENDOR_CACHE);
		};
		return {
			install,
			activate,
			handleFetch,
			readLedger,
			writeLedger,
			recordGeneration
		};
	};
	// src/sw/sw.ts
	var bootMarks = {
		timeOrigin: performance.timeOrigin,
		evaluatedAt: 0,
		firstNavReceivedAt: 0,
		firstNavAnsweredAt: 0
	};
	var mark = (name) => {
		if (!bootMarks[name]) bootMarks[name] = performance.now();
	};
	var sw = createServiceWorker({
		buildId: "2318801958a5-9e8e2328",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"1518baae9a00af65\",\"/knowledge-medium/index.html\":\"1518baae9a00af65\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-D8pVVXMQ.js\":\"8fb22871becf625a\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"a5527daf31981e43\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-COcjbTLm.js\":\"85db3da875d9f686\",\"/knowledge-medium/chunks/FacadeVFS-Q-dlrfGs.js\":\"78f0174cc58716a7\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DmsWJUua.js\":\"1d42f9e4841f2e46\",\"/knowledge-medium/chunks/MemoryVFS-Cw1NNyym.js\":\"679d4af623f2ec2e\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-CeIlqmvw.js\":\"c66ecc91bcdc7f62\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-JOR58CCn.js\":\"4ba048916f34e9b3\",\"/knowledge-medium/chunks/Preview-DcRU2NRI.js\":\"28ad0e312f4adefd\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BUk3nhMB.js\":\"04ddd75dbe1a05be\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DN0W7rfI.js\":\"a4fe8ab81658fa30\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BigFdFcn.js\":\"63284afe5ab7591d\",\"/knowledge-medium/chunks/react-C52SpSkF.js\":\"f008af0891ef1891\",\"/knowledge-medium/chunks/react-CDO6fRrm.js\":\"a120c7789c568956\",\"/knowledge-medium/chunks/react-D5OQce_7.js\":\"912fd191c7496982\",\"/knowledge-medium/chunks/react-DHTMYEtT.js\":\"116392872eea9f5f\",\"/knowledge-medium/chunks/react-DZS7nn6_.js\":\"2f8bbb5eca24a43c\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-Cw0PlULu.js\":\"2313d3631c3acd1c\",\"/knowledge-medium/chunks/react-dom-server.browser.production-D66hZAxR.js\":\"c5dc5048d07196f2\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CXgplWPW.js\":\"ba55a14566a12b5e\",\"/knowledge-medium/chunks/react-iiLQzJTl.js\":\"1590a5e3a22c10ae\",\"/knowledge-medium/chunks/react-x4QOK1GJ.js\":\"3c3b2bed553e747d\",\"/knowledge-medium/chunks/server.browser-nPEvO1Nt.js\":\"8b3a0ba53b8c178f\",\"/knowledge-medium/chunks/textarea-C-aMghKm.js\":\"1fd861f07b7f3df2\",\"/knowledge-medium/chunks/ui-CdSKLWVv.js\":\"935cd85abfcec0b1\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"9bdfcda07b52f18a\",\"/knowledge-medium/src/appUpdate.js\":\"03dd761bc038f6bf\",\"/knowledge-medium/src/appVersion.js\":\"ac8670e9fc37b5ae\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"2db3eff79ea5b164\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"947831f911a0a4eb\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"a7610326ea7d3553\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"8fe9b8ede41dc485\",\"/knowledge-medium/src/components/BlockComponent.js\":\"3b4be346b13ddfd0\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"514af518caec1dab\",\"/knowledge-medium/src/components/BlockEditor.js\":\"84c79247f49a8097\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"d208511f14abf725\",\"/knowledge-medium/src/components/BlockProperties.js\":\"b9eb6247aae2da02\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"f5c2575ee8da622e\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"9612d2c669e2a8bd\",\"/knowledge-medium/src/components/DividerHandle.js\":\"f48afcddef51c3f4\",\"/knowledge-medium/src/components/DraftEditor.js\":\"aa2de16a773526f3\",\"/knowledge-medium/src/components/GutterPill.js\":\"335eee0fde4b956d\",\"/knowledge-medium/src/components/Header.js\":\"bafc004b2d0596ef\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"a003c1e52f1a6f6e\",\"/knowledge-medium/src/components/Login.js\":\"cf66e802ede832b1\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"517e166e0e18020d\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"db2ba2f58e51a3dd\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"7086d238e6822216\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3c7ce43a1196ea4e\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"c67b4597bf2104d6\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"90b8ec977d93eb05\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"d39156a962407c91\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"6853befd533ce3c1\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"149011142d4d43f1\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"777df0a82ed6f140\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"68236bc2010b7adb\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"3b610c069600cfd1\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"00167d86d27ae76e\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"61e7089415bcbcd4\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"d84db3c6bcae75d9\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"d01add6a72202d00\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"27679322ad968f03\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"e92733c9393bf7dc\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"5bdd5e595ca832b4\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"b962ed08308c0b10\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"0880df9ea87a1669\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"21169b04cc0ea1af\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b5e81bf2feb59c5c\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"93588ad0cfdfc0d4\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"d939c2dec1e60f06\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"2f0abfef2cbfcd8c\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"d9f84f312588d706\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"9c15f3fb335646f2\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"568511ec49bdc40d\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"b3b50d69f06c538c\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"c36e260bdd369ff2\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"75c7e22973c2f067\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"09decce4a7c431b9\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"b4001d23a7a17d46\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"4e9e2b929b1bb34d\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"78255c988ffbde42\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"1bd3773a32ece21b\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"35278d524faf223d\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"08c5919a37c3a484\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"e07ca32b95e8fdf7\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"e2c9f20dae52254e\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ea664e828c40343e\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"91cf77d4fa28144e\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1a02d234036f34fb\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"cc337b87e14eb956\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"07fc8c30df243008\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"02504487bb346a69\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"9edb4d8fff847681\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"5ee2d0db407fbc9f\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"bbec7a173f810407\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"dd4416ee6d0bcd9d\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"4dcb8afbc3b1da8b\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"a2bb1fec9bae90bf\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"ecbbcdf4600f9956\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"f10aaf895f61fe4e\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"b836110a44ec2153\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"9965347e9bd2acc1\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"effe44bd762007f6\",\"/knowledge-medium/src/components/ui/button.js\":\"3fb1c1ab4913c0f2\",\"/knowledge-medium/src/components/ui/card.js\":\"da633505b3858c51\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"51542bcce1d67666\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"f8843a731ddb2b66\",\"/knowledge-medium/src/components/ui/command.js\":\"1d82c8cdfd3b5772\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"1f6be198a037cc57\",\"/knowledge-medium/src/components/ui/dialog.js\":\"e899b40ab36bfafe\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"49d891952a2d09fe\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"3ac23eac40588507\",\"/knowledge-medium/src/components/ui/index.js\":\"bf0f52980695c9cb\",\"/knowledge-medium/src/components/ui/input.js\":\"36b24870af13dc03\",\"/knowledge-medium/src/components/ui/kbd.js\":\"6d2e09f213a42e06\",\"/knowledge-medium/src/components/ui/label.js\":\"c3e124665fc43c2d\",\"/knowledge-medium/src/components/ui/textarea.js\":\"1d97585d50b0c6d1\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"ccc478116c08aca1\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"a9c5ca34950bd895\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"f65e50d95873ae84\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"9c45d9285418cc96\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"d94d231b7b27f0a9\",\"/knowledge-medium/src/components/util/error.js\":\"db64f528ba72ed43\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"b287d34856459cc0\",\"/knowledge-medium/src/components/util/suspense.js\":\"fc443648803c7096\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"4553366bf1eb1991\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"90653318786ec6a9\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"369c9f9ec6ba1dbc\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"641ade28fabea32d\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"297ff371b9843b36\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"727d17daa40e7958\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"f4010d6a5b3380f7\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"1cf989dd75139205\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"8f95e49162c86d2e\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"18ecafaabe1e112a\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"10d927e5270445d4\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"6b3e0c797f60b061\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3f253f369670cbd8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"322e749329068bf4\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"ccc168cad8677492\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"0952edaafdc9e222\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"e96946d3ae236f82\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"168392f7d2d9bbef\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"76da7a11a1975396\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"0e78b0409782e808\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"0db9f7eb4d521413\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"3b9a7a5a8fd7b9cb\",\"/knowledge-medium/src/context/block.js\":\"c5a48e6233eaff78\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"63c489fd56b885be\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"3285721c5edd8b7f\",\"/knowledge-medium/src/context/repo.js\":\"913b21942532e3d1\",\"/knowledge-medium/src/data/aliasClaim.js\":\"57157be0ea92fdec\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"4622168cfb8c197b\",\"/knowledge-medium/src/data/api/blockData.js\":\"d07b95d022c71688\",\"/knowledge-medium/src/data/api/blockType.js\":\"48aafc6e7501e9b8\",\"/knowledge-medium/src/data/api/changeScope.js\":\"37f00d742144cb01\",\"/knowledge-medium/src/data/api/codecs.js\":\"4d95e96107834337\",\"/knowledge-medium/src/data/api/derivedData.js\":\"1048a3bbb11699cc\",\"/knowledge-medium/src/data/api/errors.js\":\"9e4ee37d9820d421\",\"/knowledge-medium/src/data/api/events.js\":\"6087f7161dc14052\",\"/knowledge-medium/src/data/api/handle.js\":\"e891d29d11af00c6\",\"/knowledge-medium/src/data/api/index.js\":\"e4d5e552d21db0ab\",\"/knowledge-medium/src/data/api/mutator.js\":\"6e16e0e4949ee209\",\"/knowledge-medium/src/data/api/processor.js\":\"c8ac30fe6be118d6\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"91463f4f1171e7f8\",\"/knowledge-medium/src/data/api/query.js\":\"9376c250534e2dd1\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"61587666ef64d376\",\"/knowledge-medium/src/data/api/schema.js\":\"e891d29d11af00c6\",\"/knowledge-medium/src/data/api/tx.js\":\"e891d29d11af00c6\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"aef8d8791b94e201\",\"/knowledge-medium/src/data/api/user.js\":\"96e79fe5fe0070f5\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"a4b729cc3bdb2da2\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"62210812c9728e58\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"6db3d7543218ad4f\",\"/knowledge-medium/src/data/block.js\":\"15c8bb91c85b6e15\",\"/knowledge-medium/src/data/blockCache.js\":\"c513a35dfe9a921d\",\"/knowledge-medium/src/data/blockId.js\":\"dadac0c5e326507f\",\"/knowledge-medium/src/data/blockLiveness.js\":\"10ce201071c55f08\",\"/knowledge-medium/src/data/blockMerge.js\":\"dff011fcc2d82b22\",\"/knowledge-medium/src/data/blockSchema.js\":\"59b9325f0ddcd794\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"18c068b13bb85330\",\"/knowledge-medium/src/data/blockTypes.js\":\"e720a592c18119ba\",\"/knowledge-medium/src/data/childrenView.js\":\"08286bd67bed1f8a\",\"/knowledge-medium/src/data/clientContext.js\":\"11467e12a0f3e686\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"e4d5ec04b4c414ee\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"38862e7ffc358706\",\"/knowledge-medium/src/data/derivedIds.js\":\"b44f013e2fd9f81d\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"52977b8a3f8da1cb\",\"/knowledge-medium/src/data/facetBridge.js\":\"3a5c1b6943e5056c\",\"/knowledge-medium/src/data/facets.js\":\"22280444448555cb\",\"/knowledge-medium/src/data/globalState.js\":\"81acc2be7378ef49\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"06c1665484800a06\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"8c9044b38e3a252d\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"9919429ab3ea3461\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"004a2f73c48a77f3\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"ebde251f406deb31\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"863fc9378b13c4fd\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"64c7ff0a77ebbdeb\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"71be9ad63d9f5391\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"de42dce861aa9e51\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"ea602fac7fab5b50\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"2870899db2146279\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"22cc8daf5b854f8a\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"04c1eb2bdad8e5a0\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"711e74e23f8e9c31\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"2ac87d004b0fe65d\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"031edd18cce4f693\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"6cd2a444b5bfd4b3\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"48b03c9ad9da55ba\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"a1ac32a5eaae6787\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"f32069f21d3b5fe6\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"234f6d52b8a81be1\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"f42e1c45569f9da4\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"77fc18e5f7b29e1c\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"4d0fc892fc2484b9\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b342165d05c843ac\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"bb93b9492c81fe55\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"866572e5bdc53faf\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"169585d756671654\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"39f91dc0ff186a50\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"9853ace2fdd9f56f\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"5d5e65bc06522117\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"1cd6726d87c10f38\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"f520bb9a4780f8a6\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"1f1fdfd6cd94d739\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"fafaedc0fe744c58\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"2bc544ff50c29fe5\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"22d40260f8860ac4\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"a5f50ee4687b89d5\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"cdf4e84b8e91329b\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"e8531c5476403236\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"c7b11a52e532d701\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"a7529fc749bacabf\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"2e7e332aa8802bf7\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"17bf73c0089c4a5e\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"908fd68b90571f20\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"97309ddab35e23f7\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"ddf58d35db228d49\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"055f8200e9908a6d\",\"/knowledge-medium/src/data/invalidation.js\":\"d0c100cf18f4b500\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"aa324071f8832503\",\"/knowledge-medium/src/data/kernelPage.js\":\"187640ff5b52942b\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"bb33dab5594031bc\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"efe54e0fdedab80f\",\"/knowledge-medium/src/data/localDbStorage.js\":\"01e87e4f6a437a93\",\"/knowledge-medium/src/data/localDbVfs.js\":\"f3637e188b826313\",\"/knowledge-medium/src/data/localSchema.js\":\"77a1357e0b541138\",\"/knowledge-medium/src/data/maintenance.js\":\"ef1018097881945c\",\"/knowledge-medium/src/data/mergeProperties.js\":\"76910cdabe20b79e\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"48982bd900f071b1\",\"/knowledge-medium/src/data/migrationsPage.js\":\"9a2c7c36d41efb87\",\"/knowledge-medium/src/data/mutators.js\":\"46283146e5c50645\",\"/knowledge-medium/src/data/orderKey.js\":\"5d10de27f9929b0d\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"8718ba306b8ff44a\",\"/knowledge-medium/src/data/outlineSurface.js\":\"87b87cd0cd56bcfb\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"81d42e4089041b08\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"7858947b3d7d9f14\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"ce6ab978b27d8676\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"8ec587ae6a6036e5\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"f07726fb73f82710\",\"/knowledge-medium/src/data/properties.js\":\"2be622fe66e82868\",\"/knowledge-medium/src/data/propertiesPage.js\":\"d31819ab6cdfabc0\",\"/knowledge-medium/src/data/propertyChildren.js\":\"9554f2e878249ff7\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"2097c1f2edbce5c2\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"7323de9984bc3b14\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"6c4eb9790f9dc771\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"49f837da3385a5d0\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"3cf10e387e1e3ad7\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"342c6ade0e8f4519\",\"/knowledge-medium/src/data/propertySeeds.js\":\"d1a4efdf93491e5c\",\"/knowledge-medium/src/data/recentsPage.js\":\"4965a690ecca76e4\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"d8c90efe377a914e\",\"/knowledge-medium/src/data/referenceBlock.js\":\"361a7a33766f791e\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"a1e3abbd3be0edec\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"dfeab727d47bb7fa\",\"/knowledge-medium/src/data/repo.js\":\"d5db4f7dba90d353\",\"/knowledge-medium/src/data/repoProvider.js\":\"46900e80dc041bb6\",\"/knowledge-medium/src/data/rowProperty.js\":\"d97a3867e3fcd7ab\",\"/knowledge-medium/src/data/searchFilter.js\":\"5f1d98fb85815951\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"7679bc63fc7717a1\",\"/knowledge-medium/src/data/stateBlocks.js\":\"bf3d8bf06785e5a6\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"10b323642fb20380\",\"/knowledge-medium/src/data/structuralInsert.js\":\"6acf294c421a2056\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"ac5414c581d51d95\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"3c47dc1ae013d9ef\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"b63c2b80af1aae41\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"b23237e8a3d427f3\",\"/knowledge-medium/src/data/targets.js\":\"ddb3853805739433\",\"/knowledge-medium/src/data/typeColors.js\":\"92e4dfa3b0a0169b\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"739163bf4739dfb7\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"b83c55d3bdde3633\",\"/knowledge-medium/src/data/typeExtraction.js\":\"d6c71e72faf4f70e\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"770cd5c4fdad5817\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"7152deb1bf22fc3b\",\"/knowledge-medium/src/data/typeSeeds.js\":\"d41816973a32b6ae\",\"/knowledge-medium/src/data/typeTagger.js\":\"b82fdd765573d958\",\"/knowledge-medium/src/data/typedRecords.js\":\"57f177774e1b448a\",\"/knowledge-medium/src/data/typesPage.js\":\"afd2c257b501d188\",\"/knowledge-medium/src/data/userPrefs.js\":\"37a3b78d3477e200\",\"/knowledge-medium/src/data/userSchemasService.js\":\"3ed8bee8d1422227\",\"/knowledge-medium/src/data/userTypesService.js\":\"7ad094d9122c2779\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"b3bd29503326ef33\",\"/knowledge-medium/src/data/visibleChildren.js\":\"48ceaa88d3c1fed9\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"a9213f2b379ae90c\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"2c3051c8f281aa90\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"92c669f2954d733c\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"c9ffef0e94105822\",\"/knowledge-medium/src/data/workspaces.js\":\"5e711c60225dbc85\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"e08f0949529aa7ee\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"201be6f655f8868c\",\"/knowledge-medium/src/editor/atTrigger.js\":\"dfcaf9b541037bcf\",\"/knowledge-medium/src/editor/autocomplete.js\":\"3384f0c2aec11124\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"f869406ae6697c34\",\"/knowledge-medium/src/editor/contentFlush.js\":\"9444da6193d4d9f0\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"c497479eeed23570\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"414270ade4728e64\",\"/knowledge-medium/src/editor/insertImage.js\":\"41d637287ade452e\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"8a64a995b9a83914\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"9a9c6e034e22ff71\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"ce035d07212412a0\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"dce15948dab6b497\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"908ed75b2d2a7efc\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"4c54c1afedad322e\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"b708c022b03f250d\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"b79ee14747165d69\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"b673a85773783e8e\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"af774a037d0bfeff\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"1a12d5d9f13f36c2\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"a110d1464cb18fd5\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"0e38fdb434b2e939\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"a200c82de265c9a9\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"34e53fbe8b9abc18\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"04d0986ea5e73907\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"3e376a7f7b19ef31\",\"/knowledge-medium/src/extensions/core.js\":\"627482eefe0ded2d\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"02f3384cb68f8b22\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"7347018595c59d8c\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"9a844f0eec0f524b\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"327154dd602eb3cf\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"07c4563c54a5aeb6\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"a21e68bd273a36aa\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"7657d344211ad071\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"36867efd827b7666\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"aaa35a6c928dadb9\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"31a2ea471a1068e9\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"9fa136dacc76aa32\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"a5ada1a54599d431\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"9f633ecf0b996eb1\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"d1bdc079f141f9dc\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"3e6d994966d2bc85\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"34e31ddf71b09fca\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"78c5114511df6128\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"ab7ea96943977e9d\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"da1b0b3b4b865c22\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"8e0cd63fe57718af\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"ba19ee2a4c2c82ae\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"ea39d2ba50800246\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"99f3c83d3e678488\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"043cde92aa0d6869\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"c7e9f5a228dd41cb\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"7121dc62adf84c61\",\"/knowledge-medium/src/facets/facet.js\":\"9b185a8f9394cf24\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"23e07fda6ce292db\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"68ded4e0e4837822\",\"/knowledge-medium/src/facets/togglable.js\":\"5f186f151ca15c80\",\"/knowledge-medium/src/facets/variantFacet.js\":\"8075feeb04e369df\",\"/knowledge-medium/src/facets/verbFacet.js\":\"60f0876a8d5cb29e\",\"/knowledge-medium/src/hooks/block.js\":\"66f25bb247b91f15\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"c4fe6309db0a8e2f\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"5c8905fed9ecb061\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"a175f9835e461737\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"ee568842e4ed87a3\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"fdff6e219d6c28ae\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"c8a1d7fc3c81dd83\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"92895a9b4bddd931\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"7201667d9f0206a4\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"b38039706f19dff5\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"94754a5e0c40d0ee\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"53778cc4e5e88955\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"6db7d77bd419b45a\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"a9c24f03c811f3ed\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"7d28802166a9a102\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"fca7df102e4c8250\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"7bf0567093346c7c\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"ca234d517622e02f\",\"/knowledge-medium/src/lib/utils.js\":\"c6a6be12a1d7f710\",\"/knowledge-medium/src/main.js\":\"969c34a2ce9c5dee\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"4095c760ce4b26c4\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"46a1a0877ddb135a\",\"/knowledge-medium/src/markdown/context.js\":\"eed04acea19078c8\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"1951739a9a4a0a98\",\"/knowledge-medium/src/markdown/extensions.js\":\"1be08e6fcbaa31c0\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"94da6639da2e035d\",\"/knowledge-medium/src/minimal-editor.js\":\"c3f8aaaba017ecd1\",\"/knowledge-medium/src/paste/armedCut.js\":\"2465f5fda04ceb74\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"4217297ee7d97ca2\",\"/knowledge-medium/src/paste/clipboard.js\":\"6cd206f45e8e0e4a\",\"/knowledge-medium/src/paste/decision.js\":\"a726f27e1286f54d\",\"/knowledge-medium/src/paste/operations.js\":\"63495e9dab8fe10c\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"68f5cc41d95fe8ac\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"a06026356bbb6ab4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4164b2b06ade3cb2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"db6540f7ecdee4cd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"25e74996168aada0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f31da7ab01195ccc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"940fcff804f23049\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"f448ff84b07fae34\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"b2a6737de16b9b43\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"69c666e4435b0f2e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"f4c99f8e65add66d\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"648d16d91c16e76e\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c4a1b3afef2ffb30\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"f6b57df5b388097e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"5f0967388a39d607\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"9fdfd99f7f03c8f7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"316801d2d123f1f4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"da76b1754dac0b98\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"5d5a580ac3435a1c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"8196b80424fb802d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"05b93d148af5bd2b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"81ed7bf9e93b78e2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"95590f94e10c639a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"9e745e3cc400cbeb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"f969e46e9796970d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3c6235385486ac0c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"141dd8164675d342\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"ce85db0151ab8ee8\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"e1decb8215f9e40b\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"dfa3dbff4834f02a\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"9ee07dfeb2872b3c\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"46d2008c7293b1c2\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"75c68c335b229d8c\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"0100d89b27339f41\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"6504921c99fd5d0e\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"990d70f5345c8153\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"2f80ae639da7431c\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"3b610f94e99456a4\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"93a1a60d23d4ef82\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"580352bbe127e58e\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"fc4b90caa721e64c\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"ab1db291d43ed020\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"3930f3fa2853c756\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"f9733cbc68f420cb\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8856af0ee82cacf8\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"7450a87258f6501a\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"4f13ef14a8d73c1b\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"7200ebfa7bf30936\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"f2aafa5d3d0aa567\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"3fa75154e014a282\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"e5b48127e12cd1b3\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"e0699b548c944851\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"eb24fe76d2e8390a\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"c33799e586719c84\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"62c39aad0930a994\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"b2dc4f7bf0076a1f\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"0c0e88fd289cfee7\",\"/knowledge-medium/src/plugins/alias/index.js\":\"d049f2a531f54ad2\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"fbca18cebc81ec61\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"ef0e6f7a2f3b4277\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"16eed4392dc95f63\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"545e2f68ac706ef6\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"6ed8b831040da0f2\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"5165ab16e7b7e6f4\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"2119377f7259890c\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"355b044a1566f782\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"689ce3df9ddb8cf3\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"84bd8e98b73e05c0\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"2eeee0d30a5bd420\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"d36a9a4304c1596b\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"1027c3e1c429d28f\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"0ebb851ed341ff68\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"a974587c6c608fb2\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"4aca8f98c8ecc14b\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"207b4e6d23984bfa\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"4a39bbd6ab7a7f15\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"a3ab9b4a1dd6d7cc\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"b199bdfe71192039\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"9bbeac8820418114\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"bfbbd984c8a6466c\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"f27d5b520ce3e1c9\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"0bf6035b7c0a6140\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"4ef0db03c17cbf99\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"d4de25f4cafe20c9\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"0a62acbd929ccced\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"68e102c1c7f8d082\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"646155c18feff446\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"2df3ec6c9efe51f8\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"92b912720d8ed340\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"8d91dd6474446b17\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"c10bb4d6db1e1cbd\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"df7bccfa8d068500\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"b6981323d959ce10\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"92160b9602323271\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"2a3785f0ac5e70c3\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"5dfdcaa3a68eb504\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"70882b3d246457f7\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"5eca60b8fb1f49d7\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"7e652ebf3f67c248\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"52b3403ee7c835ab\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"261d008c71e10d39\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"6f99930e80375d0b\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"8e55aa62ee252c89\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"48933cf7a7216952\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"d2c91820273eb8ec\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"1144dcdcb0090521\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"59ba88f13997ca5f\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"ad1c01dafbb34da4\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"132ad472c94fbfe0\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"3d7613c4ffd66ed2\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"df70e44a19d8d97e\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"4df68c34df43df83\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"340eae3d0b5b6840\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"b53e27813e46184d\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d1ee3ad920ca5da1\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"3bfbc497ddfda2e2\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"20e755f2f494ed4c\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"247930bfc2d16d54\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"3318fd6d0f3c3ce7\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"a92f349c4adc1fe7\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"836d68fbcb55d8c4\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"5a92a561beda51bf\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"31bebe94f0274fed\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"fbe87b999f4be5f8\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"4d19d3cb53639c0c\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"cf8b423b6d299028\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"6d1e12595625f9f1\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"e97ac1237c7a34be\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"7dd8a63ac53cb321\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"42922212fe24d3e7\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"b39a47d9b7499ae0\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"e126f70d9d2d31dd\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"bfab1896ec064f95\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"915a266f7c8614f1\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"1e35fc8c0696b8ef\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"628c66d120037504\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"28e36b74e33c5fd5\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"748614ef1fdae59a\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"562651008a8a9c8b\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"984dea699de108f0\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"455f30c741411140\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"fd32c681692fbdbd\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"30a99038bf07079f\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"a4f6dbf5f7b7fe4c\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"3ce2a02c17230004\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"6290369b1b9dffd6\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"2e6d4c7acc87de60\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ddb9778b19ed33b9\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"0e0d54bbde4b184d\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"b8971e4de9a69b5a\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"72056d6b60e8a29e\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"4f0ce32c74cfd6bb\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"d606414eb98dac20\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"88a15c477074f333\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"b6f633001323ea4f\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"b203015913e5e0e5\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f9d4b91ed66e4bc0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"97755ad8c115a60b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"c83c7ee1b09e6a61\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c0f240307de279df\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"8311922a1c3855fb\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0c6de957874ae750\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"e6e1bee236f9343d\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"522f764a5d036ae9\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"582634bc11a6f96f\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"217e9f4a6425db5b\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"1c04dc5a4c588a33\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"45503d8fe4764ea7\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"a43a236fe24f140f\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"af6afd351a3f393e\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"69f84193f0501578\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"270b71520d4e4dfa\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"8ce730f2bd92e8c3\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"72e23c28db2eacaa\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"64d13af50fbef313\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"bc12028bf88f64ca\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"356ba4d2a5b1827c\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"49f26ed315ea3824\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"5b5376a7e6b7bba8\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"357a3bb6c4f8b197\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"9e12c9ac5afa2b74\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"0bcca6aea4af01c3\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"a7df28156a86669c\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"b025f6b64abfb815\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"01f34ab8adae974a\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"6f9219721c144f84\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"7936e7e1ff9939c7\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"f45b668ea21b6941\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"4d38726386b1d185\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"d895379cfb4603b4\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"e915c940c6965cca\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"db373c3d88ecbbef\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"be29b0b154a360bc\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c5fbd721d7accc54\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6bb46d14720f50ef\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"35007cf28f778998\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2e33481179773e8b\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"64841134eff6791c\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f5142951a01b0d2b\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"0ab41b8c74ac7563\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2f886f2ce03bec05\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"c418498bf0423394\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"a5aaf27677f0347c\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"cc6d320e70d69b4c\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"e2f800a3fc3d9d8c\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"c92f48d18ab6ffed\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"124bc55e0a2dd5f1\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"c99967c0cfadc1fd\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"53165c95526d8faa\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"0c154db87728b531\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"5ce3ac630b694958\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"da35148071d1bb09\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"9d10cfaf36c0b529\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"551be2b308500550\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"9f6b04b97c57f8e9\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"aa15b96c9be668ac\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"332b19669652bf7e\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"890ae0486b1aa03a\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"4ebf6d8a58ede615\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"20076a545501e0fa\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"c95563aaee8566fa\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"4404994d9aa544b9\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"51628ec60b510708\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"e94cab64e79fe477\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"555ef7dd396f4720\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"57c3f966036fc9af\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"4519691734ea14c5\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"1ad36a2631fdeccd\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"f8529d8aa03c4376\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"f9ba16c8fa941289\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"99dfc7d47dc20da4\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b38d947004738ea0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"94528113ec0e46f5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6a781f6c3a9fe21e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9608345fff051f20\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"6916dbfbf22fe4f9\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"508dc502574cd37b\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8d192e05bc567bf5\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"b89c4d1be653284a\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"48a5adb66afc2879\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"d19c6a338aaaa6c2\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"e2a631f489c90c4c\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"e3ae024e846c5372\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"f7a04559344d4306\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c009ac752dc02929\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"026f2f6ff52a0db4\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"a85eba10759bd2e5\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"b093afdab0c0aaf6\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"035e701d4fc3851e\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"b1dd4960a0c0ad7d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"413a3985918bd746\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"5da1767b3883cff6\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"99beeb9f310aace4\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8ab43169144190b0\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"3638910984c2cb59\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"e97d0a66086678e1\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"ca2d37fe5b9c5092\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"53393e9bbcb14e84\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"dfdc28e1c00a8f85\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"edf7c04d2d6c6ef1\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"6c55d234fc9ac763\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"bac226927843dc22\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"79510ad6a9392165\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"1f7af1361ab8799b\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"9ac6386d2dc05443\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"89a82be5192fa297\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"14306f12853f49fa\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0f0189d577e99df5\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"22914150dfee44e7\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"322dd1fc5e56acfa\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"ab8b6e9f35e8fef5\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"a800b632bd42953c\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"cb15e15c24b0294b\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"f8c6e7dff2a57848\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"2102902ec626979b\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7f1ee5091b7dc47a\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"35d443ed211da311\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"9111d404a97c7e19\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"883e64ebf51cdaea\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"2ce274cd445647d5\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"100bfafb5e47c577\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"f9e4d06bf0d276d2\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"00cb660bab322da2\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2d8a830c54393e76\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"3e966f90539022bb\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"26776e66a4ef8e98\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"e3172a0b14a7ad0f\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"4b92ad0f9dc6c39d\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"bd8b6b0de444859c\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"348c907ee56a0fa3\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"74acc84c12c537fb\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"180ab962c0bef2d5\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"cad6c479a51d2d03\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"4cf75933c08fb942\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"4849f167a1b0439f\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"e326106fd40f3008\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"7387292408326be6\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"bf2170d6d4aa5e61\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"e7960be14082a8aa\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"7f46b7dbef33128c\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"132849e39c8bf669\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"ab1d8d6a4bbb0aad\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"506d99dbb44ce671\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3fc7b95f867a106c\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"4575330ed2f9f7a1\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"596b1602a27cd8df\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"4d915fdeb6989810\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"3cb61a9c3fe03bc8\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"fea06dbae4fb1667\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"0a8899c2dc4128e2\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8fb210386480340c\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"d5aa8faa3335c63a\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"970ca021d51ad841\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"be624f5a62f62138\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"11ed4a9918ef5a4b\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"d5f00cee1f1914ec\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"1a802d7c86178c9a\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"52554ccb528ca729\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"7c66e737551d9233\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"7e342c32e7f91f21\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"08c4f53b81afb1a6\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"3a5b3a30037d9bb3\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"0558e1048c085002\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"094a4f252b81fdce\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"f5c78a7f9fa9b253\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"fe8fc9c04e77f8c7\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"5f8ab64b0aa926a4\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"970bce2f7b9af2f5\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"eb7a92761ba7d7fb\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"76ec2e7508a4bfe5\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"a19b0e83ceb76d47\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"6a56f4453a4da711\",\"/knowledge-medium/src/plugins/geo/index.js\":\"6308d357b925433a\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"f26e5538b90d692a\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"65ee036cfe3ec78b\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"7615c7befc8d473d\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"59e12938bfb158d1\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"941862277c9f54db\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"fa7f7f8e8b6dd629\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"551a5578cdb8513f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"dae0fe43cb87868f\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"c9a1909c1410b001\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1fc882dd2ebe23a8\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1b573baa4a8f80de\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"129390af2c9f207c\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"e8d3b084ca2b4a6e\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"50f235c3b084721c\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"2d99f0c4976ea209\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"aec62172092c410d\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"59b2294c5086d520\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"130ceb4e31a4ca61\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"3aecf72b6ccdef7f\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"9c8f64f47b984ed4\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9da248d2df312d77\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b211f401f56fcad7\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"b73c478a7fdd79d9\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"3f2a73d499157a92\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"51d67631c427b011\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"5834390cb9b180c9\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"157ad6995b48c683\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"2c81ca9d853b8859\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"628142fe4fd5f9e6\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"9e3c842a3a459a1c\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"c2861863edc9a43e\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"b5b400626723fd09\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"6530fbd3bbf20b00\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"abb68f7254275473\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"29a9b1f32ee5856f\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"ff10555b8304019b\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"a48acabd75994deb\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"89da4d74baf8da24\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"a91c3aba455ca93c\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"dca13af3e1846b94\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"4591c1e64846c647\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"bf377d5b8358d7f6\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7b48277c64ca8df2\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"41252c8142a282de\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"6788ce96157d5b3e\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"cb33fdbd77aea42f\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"3bf65304fc8d80f0\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"9796a6db60055507\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"609db82f3ac18e9f\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"774c516ea649dc87\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"9b38a67a604ba3f5\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"c971b2e2720a281a\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"1b06e29075aff039\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"f30e8550d2516f10\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"6fd524ba9636c8df\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"885776ffbbd7d3f8\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"a5a947d31a232d51\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"711a9e508b6d7c6f\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"bd4b045e457f3466\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"73f4b7f62891bfb3\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"919de324fbd84fe5\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"e328484e93b8ba59\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"f179eb2b2cf54b86\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c71748e0f859c919\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"0026f7fe656d6f9e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"da4cab21718b8961\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"0de2cd1555e80e0e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4308c68590fddab2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e5f3eb02dd0d0f0e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7d2aab887581a396\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"11f608bdc04afa3c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"9b0fc5da320ac348\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5aa7258378418dac\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"dee12da00c39476b\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"48854e7d4a85d388\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"92ff7f0bc423fe4b\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"28d1aa8f2f994dc3\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"8b93b9df09797a8d\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"e8aee689bcd73306\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"9791683b60b378b8\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"e24bb942cd428d8c\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"94832e503411c656\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"4078efdd9d3ed39b\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"9c12bb47a5bb6aba\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"5734316d99574869\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"8ac2c49eedf10fe6\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"3c3693c65e5ca155\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"6d8aed1d0542eba4\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"debe78027d062354\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"cfa45434e98023b5\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"03e37db4e8426ac5\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"822e9759b8b8ec39\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"62af23263099da9a\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"b3f3a442ac484f11\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"0aa345037023450d\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"19da22845bb79a14\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"1d04b76dc64682ad\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"91c484c5896e4e54\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"ef2606881d4bf189\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"4648cdbfbd3f9c40\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"65f21f5ff2f49d8b\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"cce89e23f8d48330\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f90de983e6c01ad0\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"958cf4d80522d6d4\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"74ba89ec6de4d36c\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"c6b4fb53defce019\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"cc5c1e4e79667a60\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"6bbe5d7ea03ee1c5\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"f111db93fce0eb04\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"775814daa61c2572\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"84136c9ad0221639\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"5ee75f5ccedb77f3\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"6a918ae60a1713d2\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"773b646d513b9c46\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"a5dc59aa6297ad07\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"f00945fcd3d7cdba\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"5f70b53a5c056218\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"8777887ca6e583bd\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"120e26b3c2573646\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"d36d11091917da35\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"f54ca622b31cecd8\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"a16b49f4acb7cb77\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"64b64c7a09792f76\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"644bf5b4bb3376ca\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"476830c80a22270d\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"103b4cdd7a357216\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"af3d2165daa1fdc5\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"d56e3d3941cca6f6\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"397aa19486fab2eb\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"5fa2e9a454743e62\",\"/knowledge-medium/src/plugins/recents/index.js\":\"f33ab83aa6a13b12\",\"/knowledge-medium/src/plugins/recents/target.js\":\"8714db28fd561df4\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"a657c5a1f18485f5\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"9f5413a22dd5d218\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"0a50ef4d97bbb9ec\",\"/knowledge-medium/src/plugins/references/index.js\":\"c237fef55c694b7e\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"953f8bf690f69332\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"c8d03670df329699\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"f30b46ac0a92b42b\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"fa5ba5455ebf80ac\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3eeb106718b3685b\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"c010d07b2c4eae20\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"6da70b15fda588a1\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"f218d9cf94009dbf\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ce41ef0177f90829\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"fdecef93ecd0a50c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"cec1b95a94b4e614\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"487f9c0e18f1d599\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"974e7a8569abf70b\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"57cfd6701ab4df9c\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"134c61830256f16a\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"d3a113e8d426107c\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"51c6336b6cfcd574\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"56601d159d5bfad4\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"17d3c5db20e36539\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"fc776ff8d023b1fe\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"3bd0b7c3d8994beb\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0ec2948023984473\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"af5f09ad2df48d68\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"1f512842a8940000\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"93fdcef1fa4a52d2\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"1bcbf514f837f9ba\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"530c1bfd51bcc67a\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"15353f40af839c1c\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"637e0a3630380594\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"6f25b31c2509929c\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"fabd7c6874e25a4e\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"5c23c9f08918f84c\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"4e5043d48d1adf0b\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"257f4c79a84664a0\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"856796a6eabd669e\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"6c4358725a0e2180\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"b4eb1a50528c8924\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"f04b01dd2775e919\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"a5535a280145e778\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"5ba72944aef5f976\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"39fe365d228919a2\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"7a4130555a6037b8\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"b5ce0c278aa7f7ed\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"d7f0d4c6f7f6e007\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"fee5e19e49ee5ae0\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"c809275670a1e21f\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4d966dc111e988df\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"490256d36bd72fa8\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"6fd7d8f04d1c92b0\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"7e057da57885eda9\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"c040f0d3fcb0a2f7\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d7fa6609e51859e4\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"7b091de276b223ed\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"3f30085a2710f0b5\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ef348cd852d300b8\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"49a29eb0a7725e31\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"7a2af39914ea6c48\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"4dd66afcb0fdedcc\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"1f4824f1430bdf0b\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"cfc6302c8109a7c7\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"e93372775c870f06\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"70027da106cafdb6\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"c10693c974fb1f93\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"cc7ad3b86d75267e\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"86bee29ebcaf3085\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"3a246503d7f1b04f\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"484c298dfec5211f\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"dda2576dd4bb7149\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"d96531a7965f8ed7\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"57e39465829fa4d7\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f80b166505bf8cc4\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"e84fe23dc1e881e6\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"e92c0bebe8106a03\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c98aeb97efdd9b32\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"94b46212a7f3f1e7\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"5ad559d60f411d36\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"3d1c6427d9f0e36a\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"2d58fd3cc4e3e0cc\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"87a563a272896031\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"39c410db3d4bfb8a\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"be01041e8df8634f\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"353edc7ded15ffa2\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"204fbe676677fe0a\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"b814d0452ca21551\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"4b18087321086fbd\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"fad4c2ea9a983ad9\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"e3539644e243e6d8\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"a369fefe331580df\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"231ff06f0d9582bf\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"34c19915b463a2c5\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"491da54c735cdd7f\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"322a656e539a6b9d\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"d92d2d844e0f1523\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"96c0d25c62a99143\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"6c69744394d1f23b\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"230401822005f73f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8ca1e841ab8954f5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"5db7b48fa0a92e5d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"c3d342508e64c9d4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"27f7aeeb5bfeb991\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"b2a26c04afd1a968\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"5c6f20e2b950d227\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d49784a8d478bac4\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"677ee4b6f9621852\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"1fa6a66b67cafb97\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"b49d8311c3851160\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"29045312d4df4936\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"8459076dc9b36f06\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"b008f241cb1e2e1b\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"ac7ffea267ba4f7d\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"d78216e5a531af80\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"9413ecb0262e65e7\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"262a71b4750991f6\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"17891a9166e97181\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"c13d5128494d3aa6\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"4c9d451e46b266a2\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"adbe7291c26eecd6\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"f1510dc4d74c5850\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"df9fda2e9ffb6386\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"f026d4b6c093577e\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"2b112819dce066fc\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"6b60153d2509280e\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"79625c33ba67f22a\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"185359f5fdc4dfd2\",\"/knowledge-medium/src/plugins/tables/index.js\":\"cc2484720f3a2fb7\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"189ab6a86c98e3c6\",\"/knowledge-medium/src/plugins/tables/model.js\":\"cd42aa319eaa22be\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"ea331a143d9d19a1\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"303f020ee8b1485c\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"4d3fa886ce37013a\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"1ac27c1bb63f3cbd\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"421239aef19ebf8c\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"c7ff012ec04f18f9\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"dc12a9020e1b17e7\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"da94d8a8966d1968\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"71702e3e5300aa77\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"000432ff2181e95d\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"91014d7d3fc9d2fc\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"d6ee013c7937e328\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"2c6121ea2b267aa7\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"e1103bfad55a756e\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"1cbea6431a46452c\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"c9d633b5a2297a57\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"fd4c1903f0a2cdb0\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"a596e10762ced267\",\"/knowledge-medium/src/plugins/todo/index.js\":\"cd3c335a8b8fdc52\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"5956c92a95c49147\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"492e4a4cc7802d27\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"a964f0faf9d1f3f7\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"b9909e867a032d96\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"a2b97837167ad136\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"dc268cde725e8201\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"2130e3f7d37084e1\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"0e9e9c9cb6a3749a\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"6e93b605c6a9c624\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"687a87163348a78c\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"010009d1d4e72ac1\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"13e8bf27a80531d9\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"3702a607c57ec3ff\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"fe0c05dd6995d5c5\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"f1a200ef738e6e3e\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"515913468fd24dc8\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"dfd5addfcface953\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"eb12035045b59aea\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"98d50db56765f972\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"4aaba7900832cd36\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"e3a54612cbfb2fa8\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"522cb56b56f13349\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"0b4bd8a2f0616838\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"effdd24ee4011b01\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"bb81e58fbdebf3c4\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"ce91ebf322aa461c\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"085c7f4966e355ca\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"2b75a1657d0dde3b\",\"/knowledge-medium/src/registerServiceWorker.js\":\"7522f9d6d6f4e84a\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"942ec884e4e3772a\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"aedd53d70133ba55\",\"/knowledge-medium/src/services/authStorage.js\":\"1d811f7a350237f2\",\"/knowledge-medium/src/services/powersync.js\":\"ae4fccdda5658176\",\"/knowledge-medium/src/services/supabase.js\":\"bbb7726f7ca7062e\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"d6261930a843ffb4\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"dfeac06680d6a09f\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"2989e1409201f474\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"bbdad35054be9283\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"525e03339d865365\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"4c29a38a78028368\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"586f0b354c802162\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"983cc7ff25dd6ec9\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"9a3c2bb14de34512\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"6136a7a71fcd9825\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"62f68bcff8abd470\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"60e7ba826c10a1bd\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"9353605d316072a4\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"e4adb142d07e5ec3\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"0a4cded480b2b9b9\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"7b3d6087e8fea09b\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"ff3331a9649261f4\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"b77fc39092c7d558\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"64004e2cf1f5d035\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"242ef14a34e5b844\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"0d5565284e2391c6\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"be73a0a96551efe1\",\"/knowledge-medium/src/shortcuts/types.js\":\"8ee97c623ac5a659\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"3d72d652ce0725e2\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"0fac72e7b1e7bcd3\",\"/knowledge-medium/src/shortcuts/utils.js\":\"8d6ffc7f83872b0e\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"26ab28b6e4d93078\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"5f354af89bdda89f\",\"/knowledge-medium/src/sync/byteTransform.js\":\"5d1a0eb13956f6f4\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"354529d5fbd3dab2\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"901131c683eedf9d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"27f23dbc61026f95\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"97aad493857276a9\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"f95cd4391df78268\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"b216b083d8eca690\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"06aea1e0e1d9e74c\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"78b573a9e6001de7\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"7a9b405811d4b9dc\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"7b8cf40f0c1e95b3\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"0afd8f5af35ef037\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"d7ee5efc186d858f\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"12cc66ea01ffdf3b\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"74c7a06ab2304d2d\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"fbd5b1e92d3feaf2\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"9cea11a66f5d3abd\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"117c95e1d81d6fc2\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"f6c22c15bd0fe70d\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"1f66f84fb18dcb27\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"d16542b6646d32ee\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"598b8792883f3593\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"10a4c82da63df1aa\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"568ec1527522fe36\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"3089f4cd65acefb1\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"12530d71a58a3ed2\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"55274a73681ff88c\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"accbc819123342da\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"dc1168dba5ba3232\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"f3397b959d654794\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"bc2d47747e0fd46f\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"0d79a9df3b19b503\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"e2db09616b51fee6\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"933030db52c26b37\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"1faa5ec62c11875a\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"afce8b50e83afbbd\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"dd2db0abf103f9fe\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"21ba6425bb7be971\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"a56fb48b66653902\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"fcd5e80b9ebacc48\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"bdd6648be2436603\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"139c925dd2cb5198\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"976eab868ca2c331\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"ea9bd43e65228699\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"a15812699fee2d83\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"acdf4473b99af9ad\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"29cb7979269d8fb3\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"67e73832e9efcd32\",\"/knowledge-medium/src/sync/transform.js\":\"4c0fd777718cf885\",\"/knowledge-medium/src/themeBootDefaults.js\":\"2bff0826653ee6b4\",\"/knowledge-medium/src/types.js\":\"3907d525dae2607f\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"7d93dee062f24dac\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"498f6e5af6b6b685\",\"/knowledge-medium/src/utils/array.js\":\"09aa6734e15c6f22\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"41e5072c25a9e4a9\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"034b035011135187\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"2c0115de71ebfe93\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"d9679b88f7cfee97\",\"/knowledge-medium/src/utils/callbackSet.js\":\"176013e3fc858804\",\"/knowledge-medium/src/utils/clientId.js\":\"462b4b06ef583491\",\"/knowledge-medium/src/utils/codemirror.js\":\"fd3e3775be997aba\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"70965620b8e49627\",\"/knowledge-medium/src/utils/copy.js\":\"83c2bf4524496094\",\"/knowledge-medium/src/utils/dailyPage.js\":\"fedbb03ce5e61411\",\"/knowledge-medium/src/utils/dbForensics.js\":\"3156c2a57a9aba0a\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"1b10e23225c951cc\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"91e45cade163dfef\",\"/knowledge-medium/src/utils/dialogs.js\":\"26fc472d3169ebbd\",\"/knowledge-medium/src/utils/dom.js\":\"1b35848ca24bb5dd\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"ff1a7c49799c79f0\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"58127a79e018d3c4\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"092824df84d1e77f\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"f4b9ab10a72f79cf\",\"/knowledge-medium/src/utils/flipSlide.js\":\"310eafb1f351e653\",\"/knowledge-medium/src/utils/fnv1a.js\":\"5a11a293da35e95d\",\"/knowledge-medium/src/utils/formatBytes.js\":\"1f1a6b32281449b0\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"cd25dd29e7e79915\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"1f340551c0908e89\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"7b64ee0342400792\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"f482ebc32db639d3\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"172ea1e862812b97\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"ffd068ba47533362\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"71b3fc1b11679405\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"579980387171a255\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"3828f7822904d54d\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"fb2f4904b0c8b075\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"e3abae0d9f949c6d\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"c16401f1fb22e298\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"4df284633b17d8c3\",\"/knowledge-medium/src/utils/markdownParser.js\":\"1c4b3454020728c8\",\"/knowledge-medium/src/utils/memoize.js\":\"650402a4dff5dd76\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"0331eae2b48b1491\",\"/knowledge-medium/src/utils/nameList.js\":\"63bcc78ead8e18be\",\"/knowledge-medium/src/utils/navigation.js\":\"f08b0cc58cd177cf\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"ed7448a0ff56a498\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"40dbc60d0cba23cd\",\"/knowledge-medium/src/utils/panelClearance.js\":\"ee5b7bbbf0d4ed22\",\"/knowledge-medium/src/utils/panelHistory.js\":\"02b7b2f0d160ba5f\",\"/knowledge-medium/src/utils/panelLanes.js\":\"942d6d1006b65da2\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"e1acf65b5809a2f6\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"0e68ad8e336c76be\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"4cb88068ef7b16ce\",\"/knowledge-medium/src/utils/platform.js\":\"f0d20e00f2f0e662\",\"/knowledge-medium/src/utils/pluralize.js\":\"428844a8c534a141\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"3ab87a0f9f8eb37a\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"833fb72235b1175b\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"ea22754d1d6e84a5\",\"/knowledge-medium/src/utils/react.js\":\"d37810782e1b676a\",\"/knowledge-medium/src/utils/relativeDate.js\":\"73a81647611d1d6f\",\"/knowledge-medium/src/utils/relativeTime.js\":\"ba7c56f72b478a2c\",\"/knowledge-medium/src/utils/renderScope.js\":\"eeea6e13e327436a\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"c64a3cdd0bc62e10\",\"/knowledge-medium/src/utils/routing.js\":\"a5addff68ca4f9c4\",\"/knowledge-medium/src/utils/safeMode.js\":\"057d5147ac2a4d8e\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"330411838e80ae61\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"654f50a735f2d7ae\",\"/knowledge-medium/src/utils/selection.js\":\"485a82cbfc9abac6\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"d6d09a76a310b814\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"fa398b3d15af1d7e\",\"/knowledge-medium/src/utils/state.js\":\"45ac96ef63acc0b3\",\"/knowledge-medium/src/utils/string.js\":\"dda6c1188d35c6a1\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"4c2431350700698f\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"172cf029a0a5248b\",\"/knowledge-medium/src/utils/toast.js\":\"25162b7426054d98\",\"/knowledge-medium/src/utils/toggleStore.js\":\"aa42dfde82fd845b\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"3327cfcd907487d3\",\"/knowledge-medium/src/utils/userActivity.js\":\"7fa93c4ee7998c90\",\"/knowledge-medium/src/utils/viewTransition.js\":\"87022aa0bc66b28b\",\"/knowledge-medium/src/utils/viewport.js\":\"74204b090efdb503\",\"/knowledge-medium/src/utils/webLock.js\":\"a21e5301df92425b\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"99c3b1fd4690cd8e\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"30dc83c449cda64e\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"223b158b55a65680\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"4c4cd673381bb8e6\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"88ac46f3f0f51426\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"b37790d84e1d81d4\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"f8cb27347733ff52\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"72fe2168d36b5037\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"f6d9736d71d556d0\",\"/knowledge-medium/src/vendor/react-dom.js\":\"18e3ca153e065fed\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"8ef84a094af4785f\",\"/knowledge-medium/src/vendor/react.js\":\"1c48f56ce96e9848\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
	}, {
		caches,
		fetch,
		origin: self.location.origin,
		now: () => Date.now(),
		storage: navigator.storage,
		indexedDB,
		mark,
		bootStore: /AppleWebKit/.test(navigator.userAgent) && !/Chrom/.test(navigator.userAgent) ? idbBootStore() : void 0
	});
	self.addEventListener("install", (event) => {
		event.waitUntil(sw.install());
		self.skipWaiting();
	});
	self.addEventListener("activate", (event) => {
		event.waitUntil(sw.activate());
	});
	self.addEventListener("message", (event) => {
		if (event.data === "SKIP_WAITING") self.skipWaiting();
		if (event.data === "BOOT_MARKS") event.ports[0]?.postMessage(bootMarks);
	});
	self.addEventListener("fetch", (event) => {
		const response = sw.handleFetch(event.request, (p) => event.waitUntil(p));
		if (response && event.request.mode === "navigate" && !bootMarks.firstNavReceivedAt) {
			mark("firstNavReceivedAt");
			response.then(() => mark("firstNavAnsweredAt"), () => {});
		}
		if (response) event.respondWith(response);
	});
	mark("evaluatedAt");
})();
