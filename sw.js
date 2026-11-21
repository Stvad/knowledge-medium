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
		buildId: "8e2b7ed5d23e-0f10a06f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"c72075c916a22e97\",\"/knowledge-medium/index.html\":\"c72075c916a22e97\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-VV6GtXQC.js\":\"e5a18a27dd25a87f\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"5d33157b25c741d1\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DMmC0Re6.js\":\"25509c75c58fd0fe\",\"/knowledge-medium/chunks/FacadeVFS-jwg_a7sD.js\":\"ae8df7289319c199\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-dqBVLMS3.js\":\"3b4954c8a8c32422\",\"/knowledge-medium/chunks/MemoryVFS-CcmOpfaL.js\":\"fac0344bbd567737\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-QzsmLgxB.js\":\"d3ed8333baa86011\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BfgwwKBr.js\":\"5cc931a49aa03b6f\",\"/knowledge-medium/chunks/Preview-BlvWR10s.js\":\"a77cfd38880968a6\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DismcU1S.js\":\"b860abd4ab3aa157\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-Djr4dluK.js\":\"ebc60976ad1ca7a1\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BiUL4tuS.js\":\"b9bdfab3af4655cd\",\"/knowledge-medium/chunks/react-BrFAIYcV.js\":\"410e5119d0ba0eb4\",\"/knowledge-medium/chunks/react-CWIrhQ-R.js\":\"3fb8bd8d4b4168ac\",\"/knowledge-medium/chunks/react-D6uYU4yT.js\":\"7e94291b7e8ba0e6\",\"/knowledge-medium/chunks/react-DQ33K68h.js\":\"a18b31d3847148f9\",\"/knowledge-medium/chunks/react-DeFVTcEG.js\":\"176a721c9316f12c\",\"/knowledge-medium/chunks/react-DhPxQzPq.js\":\"57b49fe7a8ed418a\",\"/knowledge-medium/chunks/react-VVd-Gs3S.js\":\"d3f93a2eea270f6c\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-Uf8UITjE.js\":\"6390833b2b8d0f33\",\"/knowledge-medium/chunks/react-dom-server.browser.production-Ry4EEB77.js\":\"df784f55c1ed6288\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DKZbmJbm.js\":\"b1d8a757246c2621\",\"/knowledge-medium/chunks/server.browser-BzuQbsBC.js\":\"e0b8f31bee5fcc16\",\"/knowledge-medium/chunks/textarea-Dkanvega.js\":\"5fac079e2069aca0\",\"/knowledge-medium/chunks/ui-BYTNGxAR.js\":\"e5a962bf0ffe66aa\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"cc1a9a3bb61bba88\",\"/knowledge-medium/src/appUpdate.js\":\"d70055640c318fd8\",\"/knowledge-medium/src/appVersion.js\":\"35696c47affd0f5d\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"a196787630434090\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"dac1a6d0d3431fa7\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"ea78324d4f2c8e05\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"a37a93187b350642\",\"/knowledge-medium/src/components/BlockComponent.js\":\"d453cb5594df1d4a\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"784bb26792da109c\",\"/knowledge-medium/src/components/BlockEditor.js\":\"81814f4ba6d102de\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"d6f7f3056cf9ad41\",\"/knowledge-medium/src/components/BlockProperties.js\":\"589c0de20cd254aa\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"6d30abe4e26466a7\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"5633aa312a1e1adb\",\"/knowledge-medium/src/components/DividerHandle.js\":\"94b954624021a983\",\"/knowledge-medium/src/components/DraftEditor.js\":\"0c5485bf43b0ced5\",\"/knowledge-medium/src/components/GutterPill.js\":\"fbc2ae1d775521f3\",\"/knowledge-medium/src/components/Header.js\":\"732a253ca9002c61\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"8c8efd595817d92c\",\"/knowledge-medium/src/components/Login.js\":\"6bcecb7afd964f89\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"1e474e3e78153aa7\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"be649e22b6d145ee\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0060ac46fd8df28e\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0a2cbb3ebb1dfe79\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"a5405145111a5be0\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"8c225b2dabb1ae91\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"deb2e712e1ab8cee\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"5485bb5549011e65\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"3610dd272c0100ae\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"e4ac39326a0976d7\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"d4921d05b60218f1\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"b0c6ed3e3718df8a\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"777c6205c4c1d0ec\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"5872e6b79bef9c1a\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"8ac1a05df09d5d6e\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"edc7c2473c09c891\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"2ce2cc073222c539\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"5e9e6f70b06f137a\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"17d2ad736614a9be\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"e0c3e335be5492c6\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"8d518e9582473759\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"9e0f2c9bc237920a\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c44df52fe82fe9d3\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"03b05e3976689267\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"83e5840e1f61c426\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"ec5a0e69c7b6adc8\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"7e95665d4f9481c9\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"afc06726e9cda289\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"b4c1e89c32cc80f3\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"0eac1b81c9f01c1a\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"149b669ec6aa4654\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"cd35e6eca0e1e028\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"c8a8fa75d8db4acb\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"f9673518803604ac\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"2cce99bceddbe97d\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"cb2b81d95ee78fcd\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"e0dcb5b1647c851f\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"8cde2b362d7eb1e9\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"dbe6c5f4160cfa18\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"3a76ed77915f1ba5\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"2e097e65bdb82d05\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"cdb790fa2039ad9e\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"1d7f7057f13de694\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"f7f26956f13bed25\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"b4724ee0689537bb\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"05e219bb500217e6\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"30ff994e8707c3e9\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"7f0ca7d24d7bbf66\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"4bd5b09ee1f7c4f8\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"d7f5e54d17415338\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"780aeac20f8484af\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"9b6c6996f44fd26f\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"8f4f15f46c18a6d7\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"8a7bd2e84ff25f23\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"47c1b7a4efe1ebba\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"6b200f8167787362\",\"/knowledge-medium/src/components/ui/button.js\":\"7125e676830ea9c8\",\"/knowledge-medium/src/components/ui/card.js\":\"2e1893389e4f50b2\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"aad13bf6b53bdce3\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"d8de4523c7cf4ec6\",\"/knowledge-medium/src/components/ui/command.js\":\"2a876a7fd66c9676\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"317820cf7444fe1c\",\"/knowledge-medium/src/components/ui/dialog.js\":\"10ee16f500034460\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"beba2129e85320db\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"4792d9aeb44e3ac8\",\"/knowledge-medium/src/components/ui/index.js\":\"87f0d5126560b621\",\"/knowledge-medium/src/components/ui/input.js\":\"fded779006b31bba\",\"/knowledge-medium/src/components/ui/kbd.js\":\"2b890f04eff8c0b3\",\"/knowledge-medium/src/components/ui/label.js\":\"3b120e0b680e0597\",\"/knowledge-medium/src/components/ui/textarea.js\":\"75261d869686d43a\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"612293209d6b1abf\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"f9997c837339b005\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"2bd32533ccc4db5b\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"e6a505cc54a7e3f1\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"e44fedaceb3e63c7\",\"/knowledge-medium/src/components/util/error.js\":\"d56233126afa46ad\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"bfb15a0be55e518d\",\"/knowledge-medium/src/components/util/suspense.js\":\"b2bd0bc2360101b2\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"db9b27149287a41a\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"0fb738bae7c90a3f\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"44a627e79c40efb7\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"38f3e71879453cd2\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"ca4472c290183cf3\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"86047d2a5d6d7720\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"f69e12164c678bbb\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"fe3e3fd0b3c2c0c2\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"d53216d5b6cbd4c9\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"8756619bea99df54\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"4a1172ffc280967c\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"de0db5121aa86a21\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"418af3762d6c8ffd\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"87ba8c280b389dba\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"921ebac64af14ebc\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"6d9011b8949b6d0f\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"9f9bbbc77c36116f\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"fab173993298740b\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"9667c4ea8f7cea01\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"0f813ee10c2ddbed\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"b4d60ee742c8ef3b\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"912232b28b01df06\",\"/knowledge-medium/src/context/block.js\":\"53ba9d0b72886a4c\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"8f764911245be44b\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"b3199e462dca5a9d\",\"/knowledge-medium/src/context/repo.js\":\"ed1d35785848b34e\",\"/knowledge-medium/src/data/aliasClaim.js\":\"1f4f5a86c2358598\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"636b152c50f853b4\",\"/knowledge-medium/src/data/api/blockData.js\":\"b2355764868f93e3\",\"/knowledge-medium/src/data/api/blockType.js\":\"3bd157c30a383aee\",\"/knowledge-medium/src/data/api/changeScope.js\":\"29b95986817bec80\",\"/knowledge-medium/src/data/api/codecs.js\":\"cf73a9b64028e1c7\",\"/knowledge-medium/src/data/api/derivedData.js\":\"0c8f07259cc3f718\",\"/knowledge-medium/src/data/api/errors.js\":\"5a47d33920e2837e\",\"/knowledge-medium/src/data/api/events.js\":\"25c72782cac9c40a\",\"/knowledge-medium/src/data/api/handle.js\":\"11a740905f91c23b\",\"/knowledge-medium/src/data/api/index.js\":\"82ad8d1d4a713e98\",\"/knowledge-medium/src/data/api/mutator.js\":\"09eccae496bf5213\",\"/knowledge-medium/src/data/api/processor.js\":\"b4365ea2d2d1d383\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"785894a5d7408ae5\",\"/knowledge-medium/src/data/api/query.js\":\"6bac7a2d8908a787\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"1fffe18f3a20e273\",\"/knowledge-medium/src/data/api/schema.js\":\"11a740905f91c23b\",\"/knowledge-medium/src/data/api/tx.js\":\"11a740905f91c23b\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"3993b9e73be9934c\",\"/knowledge-medium/src/data/api/user.js\":\"b8e506bfad511d5c\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"76507af28c38b2ab\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"29430030465d84b5\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"883d150425588042\",\"/knowledge-medium/src/data/block.js\":\"1d38cd7314c5d9b2\",\"/knowledge-medium/src/data/blockCache.js\":\"20f70190ef3afdd5\",\"/knowledge-medium/src/data/blockId.js\":\"2d121b7720828564\",\"/knowledge-medium/src/data/blockLiveness.js\":\"0c544abe191c08dc\",\"/knowledge-medium/src/data/blockMerge.js\":\"5cbffa84bedfc9b7\",\"/knowledge-medium/src/data/blockSchema.js\":\"dd1d79b5570dfdea\",\"/knowledge-medium/src/data/blockTypes.js\":\"9dfa7bdb191a67e0\",\"/knowledge-medium/src/data/clientContext.js\":\"49fbaeefc9e15105\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"0cca560f4df93949\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"fdd0300eb0935954\",\"/knowledge-medium/src/data/derivedIds.js\":\"3699da91eb712bf1\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"41919ebc5b6c8095\",\"/knowledge-medium/src/data/facetBridge.js\":\"3ab0b4f0d120b751\",\"/knowledge-medium/src/data/facets.js\":\"c419863b9450b9a2\",\"/knowledge-medium/src/data/globalState.js\":\"e09077d374dc203d\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"bc9f67f3d1880ff5\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"c69b934fd48143fd\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"301282a3403f2f38\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"53ae3ad08213ecb5\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"641ecedd7a4354a1\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"7bc8d04b852bc60d\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"5baead07aca28fac\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"f26b8a5bcca53347\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"294b267a9c35295b\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"ad8ed89580ada18b\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"d489c972ce477b3a\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"d7da8b80e12b5e40\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"790256b86f63b4da\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"73c416166de2eea5\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"0660f8288e22cd13\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"01766b31d04f2cf1\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"ce02ba58f754df05\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"9af1dbeee10988b7\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"263c0c0cd68a2c5e\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"ffdc7b31053c5f64\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"6c0c0b3bfea3da1d\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"3f06ba3ac30bc9e3\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"6bb94dccdc82fdab\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"352efd4df7add76d\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b81a1e6c70294e1e\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"d9f2f5add1879d6e\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"29293ede59561480\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"8c845c740ce82d44\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"eeb14967c381b5dc\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"9226e7c76ab67620\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"c6ee855ef0c13a3d\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"35c46e21cd3b533e\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"71ee02c1e8ac9824\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"a4c4d5a3aba15059\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"274ac1d8de7914eb\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6724b16ead700bad\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"56934d172ffd9f73\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"ccf538c51f87eeb4\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"42509cf9225e508f\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"f05c626ce81f7490\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"98f975e7b1eabb77\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"51890079e31ff6fb\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"664ed1e2144d1b85\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"e736eda8d47f9011\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"120238eca8837878\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"ec977743432ea1ac\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"11623f7031d3bf6e\",\"/knowledge-medium/src/data/invalidation.js\":\"851770906dbf2534\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"d135e7428bae9a7c\",\"/knowledge-medium/src/data/kernelPage.js\":\"f6621fd75b1e0586\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"1e00d0071a1be018\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"b117eb39aeca4c1e\",\"/knowledge-medium/src/data/localDbStorage.js\":\"fbce1e2ab540a97f\",\"/knowledge-medium/src/data/localDbVfs.js\":\"d9509cd411116954\",\"/knowledge-medium/src/data/localSchema.js\":\"6e41b43a6774f535\",\"/knowledge-medium/src/data/maintenance.js\":\"4c9907fd0e1f1429\",\"/knowledge-medium/src/data/mergeProperties.js\":\"66efb670edf2662f\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"f438449042802087\",\"/knowledge-medium/src/data/migrationsPage.js\":\"77f0b3c40c21b9dc\",\"/knowledge-medium/src/data/mutators.js\":\"7e2032982d10b9cc\",\"/knowledge-medium/src/data/orderKey.js\":\"7ea35fc3d9578462\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"6f12fed32b8e79c4\",\"/knowledge-medium/src/data/outlineSurface.js\":\"882561eda2321cf3\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"966e65ca88760379\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"54af2174e078343a\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"42835d233dd24cdb\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"437b4020558d5fb3\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"24430523e630d890\",\"/knowledge-medium/src/data/properties.js\":\"ce0f6f013cf63dcd\",\"/knowledge-medium/src/data/propertiesPage.js\":\"70e16e4fd58caecc\",\"/knowledge-medium/src/data/propertyChildren.js\":\"eef05a97c8f23270\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"727c2328b8bacba0\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"29d48831eaabed9b\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"ddaa434d17271c3e\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"4f06d25c9354b1f3\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"2cbe31eee6ec993d\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"a781bfe9c4340d20\",\"/knowledge-medium/src/data/propertySeeds.js\":\"c793b9cc28ff2e82\",\"/knowledge-medium/src/data/recentsPage.js\":\"93ce2f5fd21bbf4d\",\"/knowledge-medium/src/data/referenceBlock.js\":\"44a141743b8f1c2a\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"2f61cc880e233e31\",\"/knowledge-medium/src/data/repo.js\":\"0e4c9aadc1d060e5\",\"/knowledge-medium/src/data/repoProvider.js\":\"3c3e6a6558cc6a57\",\"/knowledge-medium/src/data/rowProperty.js\":\"7be5f972acda5c50\",\"/knowledge-medium/src/data/searchFilter.js\":\"ec40f4e2e850f326\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"6451f1c9937ca122\",\"/knowledge-medium/src/data/stateBlocks.js\":\"fbdcd1d538c18c51\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"4f7bacb3e1830aa8\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"58148349cf84fbc8\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"de99293912c59afc\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"2bbc40c97290ee51\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"3bc64d5b8b424fb0\",\"/knowledge-medium/src/data/targets.js\":\"8a7d58e22c804309\",\"/knowledge-medium/src/data/typeColors.js\":\"33bce06d53381668\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"7a3bf4886060a2aa\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"3afabe8e8e07e2e3\",\"/knowledge-medium/src/data/typeExtraction.js\":\"8125b6216b9271ee\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"8dad7686cf40a0a1\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"fa618722c0028371\",\"/knowledge-medium/src/data/typeSeeds.js\":\"0b657af6341d4f95\",\"/knowledge-medium/src/data/typeTagger.js\":\"04301a2ba1f029c5\",\"/knowledge-medium/src/data/typedRecords.js\":\"c1694be9a320b7f4\",\"/knowledge-medium/src/data/typesPage.js\":\"d1663192743d0871\",\"/knowledge-medium/src/data/userPrefs.js\":\"2075fab181439619\",\"/knowledge-medium/src/data/userSchemasService.js\":\"acfc2933b2e7b629\",\"/knowledge-medium/src/data/userTypesService.js\":\"fd4d22710dcd057a\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"ee607209fc9f3c92\",\"/knowledge-medium/src/data/visibleChildren.js\":\"79de668227af2b31\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"6eb684da37f6fc79\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"39904fdc0fdc7ca7\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"510bc9b8d3288f3c\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"9541b5b027e62731\",\"/knowledge-medium/src/data/workspaces.js\":\"10c2a5ba4dbaaa72\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"5858964ff24c4004\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"92859393f27e93a0\",\"/knowledge-medium/src/editor/atTrigger.js\":\"711593de7b9fbfc4\",\"/knowledge-medium/src/editor/autocomplete.js\":\"67b18352d0e7e43d\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"c98fd21850fefb32\",\"/knowledge-medium/src/editor/contentFlush.js\":\"824520cae65cab6d\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"fd77d024fa63e894\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"3733c7dd3bab341d\",\"/knowledge-medium/src/editor/insertImage.js\":\"2cdbb7b2fd5bb31b\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"0a746d7602781bd0\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"3524529788370061\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"1475dce261e8abed\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"98d3073e64481635\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"adabe73a2e72571f\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"63e4bc34cb347918\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"8021d6c775a7f111\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"7de3612d6fd586d8\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"f4a28957f8c2eed3\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"a826dc7a62fbfe5d\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"fc0fca1b95835c60\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"1d53d4b3e24cefdb\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"394d270a09722ba5\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"ea259bfdd4b50eec\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"75b403e89bb462a8\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"1931ae3a8515cff1\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"bed625edb8501567\",\"/knowledge-medium/src/extensions/core.js\":\"559bf5bc34a1d085\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"708dc8871512be38\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"8472467cc2f4aa23\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"3e10856725c8748b\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"5ab618a41f10684e\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"3cdc37ac7a33681e\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"c6b3f807927691c2\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"f40237259bb49643\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"a2e0b5e7bb61488c\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"085dbb89b228f2c3\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"e0ee870a1c8e3906\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"ad5af75d0820f35c\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"d5aa0520b04dc711\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"bb662f7cd5b3c0f1\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"7458d0f396f655f9\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"f8a26f7a7c336be7\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"ac9e72adc81aa6c5\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"7676bfa1a28978ad\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"c046fdfcfa951731\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"fb9f7122aff55a27\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"f55689e013011aea\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"232a1702fa714d1e\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"4ec93de05f246144\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"0cd64435baa6fdc2\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"3f0519c4d96f624b\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"38473881c6319a12\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"9cc9e5e101c6cd2b\",\"/knowledge-medium/src/facets/facet.js\":\"7a0115dbc281e12b\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"962dfe89fb293b95\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"46ed13ff798a1ac0\",\"/knowledge-medium/src/facets/togglable.js\":\"bcd998a66ebad1f0\",\"/knowledge-medium/src/facets/variantFacet.js\":\"bb61f682133bb4ad\",\"/knowledge-medium/src/facets/verbFacet.js\":\"d5ce54df4e80f98f\",\"/knowledge-medium/src/hooks/block.js\":\"19eb585c1838dc8e\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"88841df7f1a36b44\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"cda4c8a7a852eafd\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"c09294a57b4a2c2a\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"9d6e74358100fa91\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"e9ca65bd18889537\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"2f2ffe83ec75d3fc\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"c31f30091bf7b058\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"c7c8ea3809d74889\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"76ef60f583ffbb8c\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"9c62e57bd4d1084c\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"f604c90d3379ac0b\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"4f27e0200c3ee47e\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"87053b13efc0024b\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"34f2cb72bc28001b\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"b04f4ab5c80c4e12\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"ae4160d46715ea2c\",\"/knowledge-medium/src/lib/utils.js\":\"7210d4ad26cc4014\",\"/knowledge-medium/src/main.js\":\"c0e66e6ee2c4a379\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"c894ce1f2b24a05c\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"d3fe6dea100c50c8\",\"/knowledge-medium/src/markdown/context.js\":\"fceb75eb754ed192\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"01f46f7cffdb7840\",\"/knowledge-medium/src/markdown/extensions.js\":\"5a882bbe43cb033a\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"db57fa6498a6a9ca\",\"/knowledge-medium/src/minimal-editor.js\":\"0be8e80fb1f859d6\",\"/knowledge-medium/src/paste/armedCut.js\":\"0b248ac74273a4d8\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"ff383352d853a0f5\",\"/knowledge-medium/src/paste/clipboard.js\":\"98544a9668e26329\",\"/knowledge-medium/src/paste/decision.js\":\"f3d2fcd2e6bce71a\",\"/knowledge-medium/src/paste/operations.js\":\"a9fdc7345785b157\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"614dfe936dd30181\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"ad5ed54e47bfa1c0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"0658abababb7871f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"918613cb1f289867\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"31e6af1d85b62c81\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"df350d3a449fe6cf\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"a8e25ce42923db2d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7ae395306fcdbf93\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"bf0f49bab41d4eca\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c8fe164e59a7bd49\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"0279fd0dba5e4db7\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6a1c56987af96c15\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5c68e1d49db36b5b\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"6f9396017403c875\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"bbbb1e99786ee191\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"9e33266d5b3b4e03\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"c9387c6993888301\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"2508d36a485b22f2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"8289d86913e4599e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"b37f102f9133bcee\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"a5c07ec33d25569b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"b6664d9bb59249fe\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"0dbeca0777a82ed1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"cea3707bc5728cd3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"ae1773ce1ddc7ae8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c4c8a6714ed7176a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"2f75b820b9f6810e\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"f66b4f16b59521a1\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"e010d05b488f6c97\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"eaec2f74b693be94\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"46b9e5ac23c14268\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"f2f193fdef5e842b\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"26cd8d6853c8b696\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"2d425a2d1e921622\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"7b2f7e02af35c36b\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"92407d0b0f754482\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"1d423ba2e8e04321\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"5064a2eb15ade469\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"93555a2bbaa307c8\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"812e3f9a6cb3198d\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"e6a11390e1d73333\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"31dfceed51e1a15c\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"cee4f28d2e0b8ff4\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"392f465277a48829\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"0c6142e31d8dc8ef\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"243c7796b901fadc\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"2b627aba5593c7f9\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"35d8905f5eb0c46e\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"31714e12c1376250\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"95ea38b7a8fb18a6\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"da086ac743ede9f2\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"933c8d4b2ebe0c09\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"2015242e72732c12\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"d2ca27f015dc1a59\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"bc2ac18bac2b35bd\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"c5d64b644d36f381\",\"/knowledge-medium/src/plugins/alias/index.js\":\"e1eee4072b7ea6ba\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"8defda5e4675f382\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"0b7c51671e533a60\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"6b204c4df2c87eda\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"f9169914659988fc\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"08dce1f857c669aa\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"da4ac28a3ee4cac2\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"407f55368d97801c\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"9282f5beb9cec669\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"0ad417267c9032cf\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"3cc4f208a6933032\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"9b250c9dc09f0d5f\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"2a6070a53e735cfc\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"112187a9c1b062c8\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"bcc6acb3e3b9ca67\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"79827178c5935cb5\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"5a97470b96d3d51a\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"876f15944891fc44\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"dc78300bffd0d210\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"a0f34515838388f0\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"05cdf8910866eb66\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"bf90d2d6c4f41f9d\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"07e30ccc5fcc76d3\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"65ac45931ad61e17\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"8c03bf49de5278ad\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"e5965e112646e180\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"346594debb4f561d\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"21460bce904cb339\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"9883ca47ec38e1e2\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"091a80136d23e351\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"770e8be6d921ea3d\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"948aa4ad54997d82\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"f62f893876644a0d\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"e3e27c0b85825ca7\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"53c1b5633a7586ce\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"7520f353ca8f6a03\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"31c5dfeb59640a0d\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"7684f248218d6f5a\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"9ee5877efc8e7238\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"8ecd32d92481ffcf\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"07d1dffe1267f904\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"43618839b0fe3feb\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"75cf2e78d2570bcf\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"1102c8f0188bc6fb\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"4b5094adf4f32f6d\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"0c7579879f850039\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"2bff5b97289808f5\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"876429bbc73204cd\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f5251f02b2257685\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"18b468d26cb4560b\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"cf572eb2b9138090\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"6e1845db6bc89fb7\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"5651137b676acc2e\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"70b4ec5161551077\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"c62d7542576c0189\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"4ef51ee4ab92b154\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"94f9123032ae497b\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"9ae1db21927aadff\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"eebfdf2c54641192\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"37d93d5491ba35ac\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"90ed26cce53b6bad\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"9724a980fffacd36\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"294385ed837d21e8\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"a05ea245c55dba43\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"a0d644542dc0e830\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"c84d170952a3150f\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"95641539508b4c79\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"983829c11d104265\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"9886370044df4310\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"feb88e501b8a26fb\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"204434947caeef9f\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"ba9d1962d221cead\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"3ebdd3da1da2261e\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"19d14a6bcb499fd3\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"4820ed4f54d7943b\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"cf6c01ec3efe4163\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"80fa79917f34e3e0\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"ecca531c6600a0ca\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"8bfc709294bb6b6c\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"88357e5378019088\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"61b7ab19e9085322\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8ce7a8f57aa3445a\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a8aea707be743278\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"ae480d27f02d77f9\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"f0aa73cc6db9a7d1\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"cc724f101924a68d\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"ef50f37f82085908\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b04d7043249deb3c\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"eff169a5fd0eb6c6\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"22c39bf561cd399f\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5e6083d66385736b\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"f536fc1569f45a2f\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"13ee86afb1bd5333\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"1a1353b94c555a00\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"6a02b2152d6d7ec4\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"6935009d1fc60834\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"859df596b0dd51ee\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"5df00f3d6cd12265\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"47f5d75a12657206\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"93e679903de0b880\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"b1450a4555c1d9e2\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"37818ddd0d17726e\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"45b239af50742e0c\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"8aa2a20ed2b412b1\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"18829bad00270dcc\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"fd9c62df43fdde85\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"c23081b7da06104e\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"8368fc15447b43af\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"d543d207da4006f8\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"245983c8529c3cdc\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"546acb9a94cb5179\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"b764508c6dc40893\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"496772accf682b15\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"339e0fa8507e877d\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"32a3b2d1e09d7604\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"d3154655f06e4fa3\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"ef9b0fff41b09f7a\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"04edc628b5d6c373\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"d0504dcb8f4e4775\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"02616c8517005ca3\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"33635a2b45f1047a\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"b9eff492bc48fc23\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"16461dbfc30fc207\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"2b1e0d617a31a864\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"59b1bc4061f5fd41\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"365d73cab5504864\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"a1247d028200360e\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"81ec607aa684710e\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"96c792278b3a90e8\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"a2b1c14e8bd7599d\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"f00fb8e016d142c6\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"08388a0530595d77\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8b37bcbd4792fd0c\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a07c6ded24b19f84\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ba52ff2078cd5fab\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7a60f31d80034b34\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7209a8d69ee3a4c2\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"a66f18de57070217\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"bb32a9aeed7c89c2\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"5158eea5ce3e275a\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"72de6141ee51c089\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"47a52e1d506d58e6\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"65e47999eb5a930b\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"17028b4e41c1041e\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"bea6122ffa75d023\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"ba24f6b0859d48b0\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"70dcc47c56b9d73a\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"432912ab5a06ff83\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"bcff66ba6b1d874c\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"26da43e84523c369\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"019270ada5e32a47\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"c807854811408381\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"7c1c72d842486f50\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"03e4576210a3ef9c\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"caae3aa1798498fa\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"b4133b4eec8b22a7\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"0c198a290fd9a8e0\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"503c358aa8735607\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"d04fe50f1982419b\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"db6a6511cc7a586a\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"8e4c589c63f35004\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"98351476421b6fa6\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"09509f5ae08f623a\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"531d85ad599cc98f\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"7d1cab9d904a03f2\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"898d530e58622954\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"fe266b68797adf91\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8c207133412e20bc\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"9cc0ddd0048d9981\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"449e0ac4b1758d0a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7630659892416119\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"55acd168c515098d\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"5fff077b36c6fb03\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"487c356f86c29ba5\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"6cf03e721905efab\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"0a1db019fecf5c8a\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"921870ba80898bd8\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"678f0aa9c3f8ac6c\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"a85930cbedabf955\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4ee134c87a16f837\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"34c258d8771fafb3\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"2c31ff849edd629b\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"c00be99547b98d47\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"d79bfe5d3ba1e4e7\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"2602de17c05565de\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"024dfef5297de56a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"1a71cc4215cb156a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f7f49c32122af50b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"dfccc11088e6f384\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"52d1c7eb0b7e43a3\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"94964312eb1b3a0c\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"82d36ea9ce5174ef\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"655386c927277e0f\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"30b734c8dd9ee46d\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"d61bfca037952741\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"cce3c1450ebe7316\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"4d6dea7d696e5d90\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"5e5cb58825e7ba56\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"a3d71ed17c4f480c\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"b3d9752c26133428\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9d8987aac05107ee\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"58ed7d8d57fda3d1\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"3b9cc84e47de3d18\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"2fabac2b4f7ef25c\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"716d9995c45214ea\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"e4f983f65a322595\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"928090c7502efa52\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"d05d50450dc10240\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"16d3c95603805910\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"89b7ad3a656c4c0f\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"b6b8d8c8e01350db\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"fe61e14c4f447c93\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"19c93ea1dd2e2022\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"5904b6c002681b8a\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"70721135f2245041\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"1d4f0747c2f4c2f7\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"034fc779728bd10e\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"ac4e7a84cf8b0079\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"4a34d290c8d4eaad\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"8e1b88bcdc58db59\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"1f4002056c4764df\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"0663d4750ee1e707\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"d8061c94bef98ca3\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"c47aee172ff9290c\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"3f548acf5a443187\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"dc79a68f23eff5c2\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"29e0856750d1848d\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"fe596dd259d001b9\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"60a4cd52fc63e541\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"5f3ed02fe7460f7f\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"081183bae6d7bea4\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"e9320f4938408187\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"a34e57cddfe7ed5b\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"960e437efeeba6c1\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"b7d9629f0f4b84a6\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"0611d365a52e34b8\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a7e7d9b8bf76739d\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c425d57dae136d58\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"db07ec78d29c1f4d\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"ab486985a42e1e6f\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"86abc59b34544d37\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"031993bf8d701f3c\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"bf963e5513b41dd7\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"17d84c991e31e86d\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"7df5b64e1aab6ddc\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"506c65d373ca4115\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"cefcafbaf1381e54\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"eddc8cd0ed0cbee5\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"3480d1775b307875\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"40336906a709849a\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"2687482bc7137253\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"d3978b8de246c45b\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"3dd6d1ac28b028dd\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"06514ca05b120e80\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"f07c05185d15e9c6\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"6f852d6006e63c88\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"ae20d305133a8612\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"35638d1daf16dd05\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"6d6ac9c594eab09d\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"b4543024136d2155\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"e205ab7b03a0ce52\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"39bd5d6ec5fcdf17\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"22bd541fb4ebf135\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"d0070d85fa4d523c\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"1dcbcd223746e2fa\",\"/knowledge-medium/src/plugins/geo/index.js\":\"37b7175c0fc388aa\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"a6fe5f6cb7254afc\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"6c331cbbe287fd5a\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"fb971276f1eab7a2\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"633df986cd0304c1\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"033cd014e0a11b4d\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"def7cc0a7b362676\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"a75bb8a0e26f303e\",\"/knowledge-medium/src/plugins/geo/query.js\":\"d42fb17a1c591a3b\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"f2bfaec19da8b50f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4212b00b3cbbbc59\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"48b4d1779ce10403\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3af2e34fbb68c9fc\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"3f80bd361c26eeab\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"9c7084ede36d5cc2\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"9c19ce8aac4e66c6\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"2be0a2246eac9969\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"6e2274ae1d23d565\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b55f997bccdeb56c\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"a0a916d1f1d1b82c\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"31cad48905b96ea9\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"b52dae7bc9ebb875\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6fcdb3e2f017e4b3\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"b43383d296c30c32\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"d7f68c22eeb6cacb\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"be1ee080ef045fb8\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"8d64f9152a0fb37b\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"e4b7612fdf63f330\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"14094394e322d7c8\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"655d381172e85802\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"d1f79600f81c7ff9\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"89c7e7ac3e635fc0\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"8984c30fac044f7f\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"79dca9e859b061ce\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"59530c43c5897b2d\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"1eb58d99d709574a\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"e280b47f29d420c6\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"f09afcd0b3766387\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"fb5a1f99300460af\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"985ddf33814fdc05\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"6ce39c39571430bc\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"6bc325d476d80cc7\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"bcb67e0260e03f5f\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"767d94bf21412f06\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"1ffc0c21b8593ed6\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"8cc171d3f69b17fc\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"4131bc290d82272c\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"40e0313ec6b591e9\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"4d6068465e122570\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"833fe1f27d1c028f\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"928e2543b1899459\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"cd6e758be96a8323\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"8181d0bb3640d9ce\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"deb0ce833ded9e08\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"b5ba39e63f5b54fd\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"65d28517aea1bb69\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"a5c0d722ff0e673b\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"011057dfba529ddc\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"af467a08dbc2b640\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"4f3d5a7cb4f355b0\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"327fd22ccb00b96b\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"607883fe133df6ea\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"b87d608d50cc4a77\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"720c4f265e8c34ab\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1201547ee68c6e73\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"0852c518b9af4b93\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"9b499ab810d8d68a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"1d7de87eb4381444\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4d704d6f505b7657\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4da16c88226decf2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0fcf4e94b1874c93\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c9c49910e7c13a1e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"112199111b7a01d5\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"1277f4b44303a3b2\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d12f067ee118f3b5\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"bc13a486c7a94dfd\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"4b54676e8569628d\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"4c4765b152e3fd69\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"d42afa1c52c69025\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"b4de45375f2e534f\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"9dbda5c1da6236e6\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"f9bacc6d09ae2154\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"b43d767815023293\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"7606a54729bcba79\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"b774432ae6d2fed9\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"f0390e6ac917877a\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"d8961a3e6be4863d\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"d3745b7c69e710a1\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"9329f119b3ce93a5\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"20815d9ac363650a\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"b1ba636764fbb15b\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"8201298c71ebb945\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"882ffd77f9125ee2\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"430616812c31911b\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"fb943916bd00c913\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"5bc842b516478e4d\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"634ac4cc035d0ea4\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"93245f6151bc90e3\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"00439ff1bbe95ace\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"6dde8509fe8a50c1\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"cc21b821c21a82f9\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"5ea074e44be298dd\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"ecf9e6f3469d30c9\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b6209d26f0829489\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"c73bd26668d03057\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"e6a68eaba73b5401\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"1a4f3721f7ec0dc2\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"77b74bf16c40b3ef\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"79aef935786558b4\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"32ff4aebf72667d0\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"63d408d614906993\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"c30d7fc8d402a9b9\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"15700e5f7d323537\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"202992467d74ea62\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"eea99f8512639e55\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"79cb24cb46333125\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"0e4cad657a0d6266\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"4e2117c4457e8e23\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"7790dd8685d152d5\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"99b7bf0f4352a922\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"9c0e0c4bc89a9678\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"f5ed6739cf76cc4c\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"17d02b13127cd214\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"c3e0561b2b8bd600\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"12875cb491c2ca76\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"aeda51b8632d2477\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"334b5dabaff3994f\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"a9a6edf63a8c8296\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"df4d116879da29fb\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b4c845cdc8ffc191\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"5a91e8bd08d9e477\",\"/knowledge-medium/src/plugins/recents/index.js\":\"1a949fbfc5322634\",\"/knowledge-medium/src/plugins/recents/target.js\":\"e09e165deeddc8a9\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"a4969399c7266a96\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"0c0c7acc6f2dbb43\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"092d48c176cf8b60\",\"/knowledge-medium/src/plugins/references/index.js\":\"4e821d0d5f02c736\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"19ac6f28b0f63fc0\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"ee394a4d93110c30\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"e138dd89a7a70cb8\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"b99449cee8c41deb\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d698114b0135dd01\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"056958760386edc6\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"79fcc83be776a0c8\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"1af9faaf6df78084\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"16e9cd528f22f39a\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"c00a6c4b7b0b4ace\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"00bff84b4529be26\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fa4fb47b40b0fae2\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"320ba06d917dfb85\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"f3c1cf7bca851923\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"eab737003e155d91\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"cb615251b7c01e86\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"613bda44da5cce4a\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"66dbfa31636591dd\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"0516b6da866e89ab\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"111e1c6a9dd9bb29\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"26eaf397882c711e\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"42305e860239b25f\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"cac04d5a8b5bf9b2\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"73c6d0fd029a2c7f\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"77d82c04f8305af4\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"fb7e528fb323204d\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"c222ad985f31cfec\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"862add6ae4598c86\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"9436eebddecca52c\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"f54cbc15bb05e553\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"a60ef0c3e5a634fb\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"e76dc03cd65b60bc\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"8d19cfdb0c504d8c\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"634ac18a332f7ea2\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"948e1dc83db45a08\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"8bddc06d124dbfa4\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"7fbf82961c0b7618\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"04a850a0f120aae9\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"3ccdbeb939942d39\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"c5b2051ee5e59392\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"4fba8ccae9881ea8\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"2623b6b778e40911\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"e7e6e5ac90576463\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"92241b2c0ae1bfde\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"117b9ed49b09463c\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"a4d5e3af54782d43\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"601db12d8c43382b\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"8a1bbb35c8f88828\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"a78184f3a4a13bda\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"b56bce0a086a9897\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"17972480b598e6de\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4de0a4a540ed1a5a\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"156c8efb8ae86e60\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"26210a3c1f32d543\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8d72497ad73c4072\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"2875e905bc5d49a5\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"f05fde700cfc0b5f\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"127f0743dcb04a09\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"6227071b23b8d412\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"26733c85cc57637c\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"b0bcce968400e845\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"d67a7da460971cca\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"543a5205c47ccae1\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"3ed16e130fd635b2\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6dff9caa4d7b991c\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"588e0036de3d95bf\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"02724e40f23b8b8c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3c1e5673a1754f45\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"58619432a7fbbe07\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2b5d865f9cb6809e\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1298f4221b013762\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"6467bff55de12878\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"b2477e1f131a79f2\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c8ad205144612744\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"761cd64a46291b65\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"429b21d50c95ef37\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"20f813bbee9a51a4\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"311a9cc5a3d96e98\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"6ef48e79a1bc15c9\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"392235da9b1afcae\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"766d29166062d152\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"2511d6ac96b22ae1\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"6938b522cfbe42cb\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"2d7bee5d96e96454\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"0fa2c3def168a353\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"f5f7d71dd6316cfb\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"8ff85a6f60e2a878\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"f1679103ea586060\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"c9419beceba4f3d4\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"3dc7a75e2f5e8e1a\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"f5514c4e3ee51175\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"bfe572171b680a51\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"3a7fcfc24669d44d\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"59fe90b193084439\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"ffe69395828a3127\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"1ffd9265f631de70\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1539121320d1f9cc\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"5210f18ebe8b796d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"a97d779e1144512b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"e319bb98cc5dca33\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"5b4c0f4e121b814c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"f55b161f73c210e2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"6b964048f8d0de34\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"d3bde6dd423dc1a7\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"daed82a0503dc30f\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"633b6877b858a3f7\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"39f31dc92a14b256\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"964f1d5de39f5d17\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"158ae13b4d6506d2\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"77df1c55a153aaec\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"b4710cd2bbcbf2ae\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"74accb975f71b6af\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"b9d5763f614fba9d\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"eaaf05ff9c811f6d\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"26095392ca231459\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"c3ec189f15ce780e\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"f48bd56fe70a94fc\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"ac11bdba2efd14d8\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"d39d4ea36998a86b\",\"/knowledge-medium/src/plugins/todo/index.js\":\"882c9c41eedf68e9\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"383aba3732502d61\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c408e3a1da762e7e\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"d712effd1cd1a77d\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"42c116bfe0713fa9\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"36402288bc09813a\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"e1cd6e8e32982443\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"4400b7fa72226fc1\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"3cc9c4c0f96645a4\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"71f086dfdef95b70\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"67aa6bf34903e15a\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"6031683ee2d4490a\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"1633b641dce3df25\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"a81a7acbd36e9ba0\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"24bcde7110f494f2\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"ecc9dc463e708acd\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"8d63170517c3ed3d\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"16656d2e6bd8c55b\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"c44decaeaafcd66e\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"214ae0f9df1d4447\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"bf30c00a468e2e36\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"ac2bc93cbd725a6e\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"c495a12c70479142\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"b15faa02c0c9d0de\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"f7065f1b48bdf604\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"c30e28ad52b6cc95\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"0d360d8f1b5dea1a\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"cd2504f7f416af79\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"8ac33d394a725276\",\"/knowledge-medium/src/registerServiceWorker.js\":\"5fc5280e4a82cb68\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"792eea0b30232b50\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"ebae8affe5248877\",\"/knowledge-medium/src/services/authStorage.js\":\"9086a2e45285f8d0\",\"/knowledge-medium/src/services/powersync.js\":\"e217bcd7e78129ec\",\"/knowledge-medium/src/services/supabase.js\":\"63ff0ebe21529f45\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"da3f80a3ac2b92c9\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"c38d31ffd6a06cd7\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"3a6f03263b6a06ae\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"26d87ca0bd69e1df\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"9712ff4bdaeec8fa\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"1ce780a3ad897aab\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"75a63adc5783c64d\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"331586d28a5e3199\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"5be5b604d6dc7f2c\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"336d5f56839fe8de\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"2dee7a772cc0cad9\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"ae0158fe31d5821c\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"70fe6f6a785394f8\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"bcdeabffb767db4b\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"dd2d6caea37770df\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"d9c837b6e87bd857\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"cbafa09223ce0dd6\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"bb15a81ef6963477\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"e124e1a60c9d1276\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"f42cea133e21b930\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"e4b4510445a4ef50\",\"/knowledge-medium/src/shortcuts/types.js\":\"77a8e16e79efed3a\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"da1b571891e93553\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"759eb2e1aff44125\",\"/knowledge-medium/src/shortcuts/utils.js\":\"2001dd1d36c00856\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"6c427ef3f9c492ee\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"add371c549c5aada\",\"/knowledge-medium/src/sync/byteTransform.js\":\"3a8a394c8688d8d9\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"e23bd82ad465ca61\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"8bbc0faeaa6bef41\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"e46771065a0e807e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"6fd6a77c01ba0a26\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"d1505ab030bb0951\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"7da79d32ee7b0bd8\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"87d1f83eab90d986\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"ac4f25ef1794b14a\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"d39883503ed1e394\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"f5a9108d8b49ecd9\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"1270ca16ef2da7d0\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"cd70d9fba2b6b7ce\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"ca85b70eafc28e13\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"745b38a10bc5947b\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"1f2511927ce6e6e4\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"264830e87a29224b\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"e21811fdd30f7847\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"a1d82cfcce262008\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"a7667b9eafa5d70a\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"739ebdeaf5a8989c\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"2f259001aebc788e\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"fd533b0d8bd54d83\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"f656b36e793df5bd\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"02ffd2b7d5242095\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"1e0920e95618b788\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"f4d914f7c043a9bd\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"aea1a3f774657529\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"449613f2532a2865\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"ef8caf902ca55cc4\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"7762455cdb20ee87\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"364fd1dd36efc4f3\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"20fbfabcaf89477a\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"6798426f47292734\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"dfc247670d7c441d\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"c7903f9b8e83e51f\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"e0ed13455c0d7aee\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e9691e563ba09214\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"5d708ad22d77279a\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"62fde0a6821bbb2f\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7966ffaa8334c3ac\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"98ad1b9d81e1f26a\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"37ec30aad326bdc0\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"322ec2f2cd3bfe71\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"3cd0c3f17a8442b2\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"90c1a2ac205cf853\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"e3bc067e87e5c74e\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"7d4bbc4c6514d812\",\"/knowledge-medium/src/sync/transform.js\":\"a65bfe81b92f626e\",\"/knowledge-medium/src/themeBootDefaults.js\":\"fcb81dd690f4c3a8\",\"/knowledge-medium/src/types.js\":\"34d816f711dd805d\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"66a25a2b7c3ae7fa\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"699e687a3bcaed29\",\"/knowledge-medium/src/utils/array.js\":\"a4ec3f2bc22d292c\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"67a3ad88feab879f\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"e4f02e6033965b7b\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"0cb8acb2a5af508a\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"25fb91abe1c3aef5\",\"/knowledge-medium/src/utils/callbackSet.js\":\"51dc5f998adeb9a7\",\"/knowledge-medium/src/utils/clientId.js\":\"9033a7ef541c47ad\",\"/knowledge-medium/src/utils/codemirror.js\":\"2073ceecbb45d60b\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"e3bfa2313c3fa8e4\",\"/knowledge-medium/src/utils/copy.js\":\"531507f6da6e5b19\",\"/knowledge-medium/src/utils/dailyPage.js\":\"5197aa07f36ef011\",\"/knowledge-medium/src/utils/dbForensics.js\":\"2760b593e6ea8577\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"11c040dd1e30fce6\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"63f2e11e5a31b76b\",\"/knowledge-medium/src/utils/dialogs.js\":\"fdc06095db578c13\",\"/knowledge-medium/src/utils/dom.js\":\"203498a771a3de97\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"3d5b3bf5753d2bf9\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"634a768e840afa08\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"e5a9d187e82f08a6\",\"/knowledge-medium/src/utils/flipSlide.js\":\"cf8a151526fef60d\",\"/knowledge-medium/src/utils/fnv1a.js\":\"261a668943d9d469\",\"/knowledge-medium/src/utils/formatBytes.js\":\"4723bc4dba24ef0c\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"10cfbf53e262f023\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"290dc6eb1e112012\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"fe55a9845bb0bf82\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"c8fe43995903304c\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"e883caf3f1a4d308\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"ba52164833f0f0f8\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"72cf305587bfaccb\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"e20d33e6c6a39e25\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"9aa515999f47792c\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"74d0af59d33e40b8\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"452ee63bf45ee732\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"67c5bc53cb48aec2\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"d9066419d9720948\",\"/knowledge-medium/src/utils/markdownParser.js\":\"029bbcf11b0983c8\",\"/knowledge-medium/src/utils/memoize.js\":\"87f084eb1d1f41dc\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"2dbcde76a62e2d5b\",\"/knowledge-medium/src/utils/nameList.js\":\"125d0e9376a55d8e\",\"/knowledge-medium/src/utils/navigation.js\":\"1b9813afa0584e7c\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"fee465b2f24d32b3\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"a1851c72fbdaa7b9\",\"/knowledge-medium/src/utils/panelClearance.js\":\"0429b4b6bdf5b102\",\"/knowledge-medium/src/utils/panelHistory.js\":\"bd6f267a42ba977a\",\"/knowledge-medium/src/utils/panelLanes.js\":\"3ef7599d141c9a2a\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"05e4e0d933212c88\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"22229765496ebca2\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"e33f6784a0096e54\",\"/knowledge-medium/src/utils/platform.js\":\"b824029b6aeb5ea5\",\"/knowledge-medium/src/utils/pluralize.js\":\"36c14b8d8226f8b3\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"8fb94870372622db\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"aba6eeb3c71b835c\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"cb365f2375fdf1be\",\"/knowledge-medium/src/utils/react.js\":\"348f0e07146acf6e\",\"/knowledge-medium/src/utils/relativeDate.js\":\"78d71fb435597ba7\",\"/knowledge-medium/src/utils/relativeTime.js\":\"894be80974cab206\",\"/knowledge-medium/src/utils/renderScope.js\":\"c353b1391c038f49\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"2f4d640d20aa723f\",\"/knowledge-medium/src/utils/routing.js\":\"4a3e9ea30a48c5cb\",\"/knowledge-medium/src/utils/safeMode.js\":\"56ee97ac51570fcd\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"d8446401b838d4bb\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"202288a593951943\",\"/knowledge-medium/src/utils/selection.js\":\"6e24fe7ff7e1bb03\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"73bafadfa9568376\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"462961016d96654d\",\"/knowledge-medium/src/utils/state.js\":\"8d5732eebe4cb514\",\"/knowledge-medium/src/utils/string.js\":\"4bdc1416ca01984b\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"c8db53d936e1974c\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"c93f735fa4756b0a\",\"/knowledge-medium/src/utils/toast.js\":\"c164a6ed81c167a4\",\"/knowledge-medium/src/utils/toggleStore.js\":\"4e6f0a0ddb2cedc1\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"0c69db4d362f29d3\",\"/knowledge-medium/src/utils/userActivity.js\":\"f29d9d075b968adb\",\"/knowledge-medium/src/utils/viewTransition.js\":\"38f1908a9dec3358\",\"/knowledge-medium/src/utils/viewport.js\":\"ac466ad6fbfdbdbb\",\"/knowledge-medium/src/utils/webLock.js\":\"107d17a33ff2e327\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"754340788364a903\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"c159998f78ca3581\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"8b401c34c3cdf299\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"fbfdd135f517b95a\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"e07cc4d69cf1efd9\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"1e11d7903512f419\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"e7fcc98cc38a5c0a\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"24d15b5023f7050f\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"96db4e0eb5838d30\",\"/knowledge-medium/src/vendor/react-dom.js\":\"ea3af6f6faf0710f\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"0d7370eb6d6873a3\",\"/knowledge-medium/src/vendor/react.js\":\"cbdc03bac736c55f\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
