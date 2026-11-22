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
		buildId: "54ad2ae3f3a4-d50cfbc6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"06bee59a250eaf97\",\"/knowledge-medium/index.html\":\"06bee59a250eaf97\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-B01lqcBr.js\":\"b55018d049a30ced\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"0044e11bd156c572\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-UoB7yiB8.js\":\"103fbfb15869c6e2\",\"/knowledge-medium/chunks/FacadeVFS-CBtkyhZj.js\":\"69070596fd939a32\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-B_VZIJzS.js\":\"9aa984c1bf89171d\",\"/knowledge-medium/chunks/MemoryVFS-C9uJ2SJF.js\":\"aad66f8eb5eae05c\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-Be3vH7Y8.js\":\"fa874068c5b9cbef\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-O5PWlxDX.js\":\"906fa05c9a41f314\",\"/knowledge-medium/chunks/Preview-CKBZxRLC.js\":\"d62af3d5af1adb32\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BnvCIf1p.js\":\"61932cb3895929df\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-cv231uaR.js\":\"ad86bc574c197dd4\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B8eOckPU.js\":\"9a2227375a11bd7a\",\"/knowledge-medium/chunks/react-BvkPxS5Z.js\":\"0b801f266c947805\",\"/knowledge-medium/chunks/react-CMkI8Usa.js\":\"c13c5442a0553a03\",\"/knowledge-medium/chunks/react-Ci2p6zZV.js\":\"39a37c5ab031e2e1\",\"/knowledge-medium/chunks/react-D5a1yUdw.js\":\"c699c176cb006f7f\",\"/knowledge-medium/chunks/react-DmP5sX3I.js\":\"6db5aae23c2e54ed\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DX3FGCrQ.js\":\"d42793e08b986bd3\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DLLydDF9.js\":\"99bbd5de7561ef0f\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DB1b0fSu.js\":\"d305c523caf2da88\",\"/knowledge-medium/chunks/react-nmEdCuhb.js\":\"d3ff42c569caf9d3\",\"/knowledge-medium/chunks/react-rFTbJ3IJ.js\":\"cb6edf1a14928af3\",\"/knowledge-medium/chunks/server.browser-Wtqi3X5D.js\":\"23b4c72c38b7f9d9\",\"/knowledge-medium/chunks/textarea-DLkCuCTe.js\":\"602b97d15cd3ec93\",\"/knowledge-medium/chunks/ui-BvDy4RBC.js\":\"87904ade8eca9512\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"6e1834683df6ce23\",\"/knowledge-medium/src/appUpdate.js\":\"9ee260b57dee44fb\",\"/knowledge-medium/src/appVersion.js\":\"843548b03a56c735\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"ce6084f86ced6413\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"a15c56e230ff4b16\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"ae3f54a42a229d37\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"23f6558ec115f048\",\"/knowledge-medium/src/components/BlockComponent.js\":\"48175b3b9b9f2e0b\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"94afafccf93a0ab5\",\"/knowledge-medium/src/components/BlockEditor.js\":\"f0a02a46d63a039e\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"df1aa8dcd6c5dfc0\",\"/knowledge-medium/src/components/BlockProperties.js\":\"7bcde63597aa6d49\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"77aea8ec6d164d61\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"fcd1a4daec64bdde\",\"/knowledge-medium/src/components/DividerHandle.js\":\"9e2fdffb37dc43fe\",\"/knowledge-medium/src/components/DraftEditor.js\":\"de7840a179221658\",\"/knowledge-medium/src/components/GutterPill.js\":\"cd3dfdf1589f3dba\",\"/knowledge-medium/src/components/Header.js\":\"cafe9005c9840351\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"dd1df757392e7c73\",\"/knowledge-medium/src/components/Login.js\":\"f7fddbdda2152c90\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"99fbca173dbb5f17\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"361b9a0f6259287c\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"65cf983be07a3cbb\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"877c83d0b98bd7c7\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"f0c128d0b1af1755\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"023039a40b9a9d0a\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"35d1b72018816131\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"a00775d626c9dccd\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"a3a1912d4387e2ad\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"c3b7ff82a5030752\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"622cb8080fde2913\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"fd7050b5663cbff6\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"6b25d145e39750d7\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"98333649a335a2c9\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"268420950fad7073\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"39b0e96f07743d39\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"0233e76236b4b068\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"8567d244b14d44b3\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"df59935fa21dec90\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"3e898766defabf1e\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"3673476a00bee7ec\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"bf189674478552cb\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a3db523d7aafefbc\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"d8f05148b1418307\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"6aeec3df48053121\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"b3c41aae7ca20688\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"d3e37645cb2e284f\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"23a0133ec98d8174\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"a74c73c5414b195d\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"46da788267be440b\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"9633bd453575f755\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"cf4d3f1c73a1b65b\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"d4defcc471a12c0d\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"54a05139b20e4122\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"cc93dc160db7df03\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"ef5ecd6a1c9234d1\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"74e95937d64c88e8\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"7ceb0844b554c775\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"35fdf30a7de4f34f\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"baeee1e70e106799\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"8f07426d03b3b5b1\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"2efbc2bb604ce752\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"a3a8e65acddc5373\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"283af9ed10f324a6\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"f1cb5647cc788810\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"e7469c437d55ed11\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"fe158be065adcefa\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"74511fd94ec04362\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"243542356e37b933\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"0e8389e7666110ed\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"1df49a76d2052f02\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"8beff6579e2333d2\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"d647312cc05abe4c\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"98fbfcc3659f51c3\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"e6a0d15ff939c2a9\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"febb53fba3df0162\",\"/knowledge-medium/src/components/ui/button.js\":\"437d235805fcac42\",\"/knowledge-medium/src/components/ui/card.js\":\"0be5915194ee5f00\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"a4d87b13b1f7bf72\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"74619d2b10003253\",\"/knowledge-medium/src/components/ui/command.js\":\"59d4ed46a6a41f70\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"6a4dfe7ad98e9a48\",\"/knowledge-medium/src/components/ui/dialog.js\":\"4496a20cd5e044b5\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"f5e8a7112993cf32\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"763470282adb2b12\",\"/knowledge-medium/src/components/ui/index.js\":\"e1b40b0df2ed106f\",\"/knowledge-medium/src/components/ui/input.js\":\"d0ae2647fa55fc6a\",\"/knowledge-medium/src/components/ui/kbd.js\":\"34490604a82e6b60\",\"/knowledge-medium/src/components/ui/label.js\":\"fa6fd0a29a8a482b\",\"/knowledge-medium/src/components/ui/textarea.js\":\"47603cb2d6d5f2e0\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"1050971e65642d3f\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"56468e963ee629a6\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"e24bad8ea7a7d6a5\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"331097ae71a2bb3c\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"4f7c6187ad0926b9\",\"/knowledge-medium/src/components/util/error.js\":\"c87428008155c04c\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"fed8197db91dd0ec\",\"/knowledge-medium/src/components/util/suspense.js\":\"fc8913595ba78e85\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"79632c99569675fd\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"387aa9a4cf92f53b\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"4225bc7a525d6eaf\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"98fc9fb629e9bf31\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"dc1bd590537def59\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"9c1c67a9065d725f\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"f35b9fabb1b1e8a3\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"3007c0021a3d7c10\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"9b42e7ece271a5c0\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"c1addb54af86c31b\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"5a226b4a36297036\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"60dc681abe5cfaab\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0217be0f083e940a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"beee582f096ef3a7\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"bde15d26d6a257ae\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"8e6f4c4a0f6e84d7\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"60b65de2c5836f61\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"fd4367956c1b5ce0\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"2b13bbdf99951b9d\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"c87047e7f9f153e4\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"bebe28a9a63b3727\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"fcf8fb0132d9fd22\",\"/knowledge-medium/src/context/block.js\":\"0464d06e1e310196\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"4315819a28d6ab05\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"be96c59fe42d1b9b\",\"/knowledge-medium/src/context/repo.js\":\"3a25defced81bb9a\",\"/knowledge-medium/src/data/aliasClaim.js\":\"391029b65ef819e9\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"71854748b279b4a9\",\"/knowledge-medium/src/data/api/blockData.js\":\"c83e011b87d2543b\",\"/knowledge-medium/src/data/api/blockType.js\":\"0c3eb1a992f7f037\",\"/knowledge-medium/src/data/api/changeScope.js\":\"b2671368831add73\",\"/knowledge-medium/src/data/api/codecs.js\":\"018134b5a6e4e5e4\",\"/knowledge-medium/src/data/api/derivedData.js\":\"938eae7034d6d556\",\"/knowledge-medium/src/data/api/errors.js\":\"83c968ece73a3fb9\",\"/knowledge-medium/src/data/api/events.js\":\"2bbf9a8d8b1d308a\",\"/knowledge-medium/src/data/api/handle.js\":\"6dc289b6f2e9b427\",\"/knowledge-medium/src/data/api/index.js\":\"8765c45fdcf8bb1a\",\"/knowledge-medium/src/data/api/mutator.js\":\"b78e707cefe03182\",\"/knowledge-medium/src/data/api/processor.js\":\"a4e82ef75175ea3c\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"3509bd030404c1e6\",\"/knowledge-medium/src/data/api/query.js\":\"e961f460b19e5fa6\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"ab6244d74d8b189b\",\"/knowledge-medium/src/data/api/schema.js\":\"6dc289b6f2e9b427\",\"/knowledge-medium/src/data/api/tx.js\":\"6dc289b6f2e9b427\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"f0a70699ff249f3b\",\"/knowledge-medium/src/data/api/user.js\":\"913b51ce8b108893\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"93fd60ce0580b286\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"3d56a2a05c547050\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"340be0f1b89e6448\",\"/knowledge-medium/src/data/block.js\":\"737cf697424dd86b\",\"/knowledge-medium/src/data/blockCache.js\":\"625895178d9ba6d0\",\"/knowledge-medium/src/data/blockId.js\":\"e7d4aa36c3104f26\",\"/knowledge-medium/src/data/blockLiveness.js\":\"a41eacf1c05e512d\",\"/knowledge-medium/src/data/blockMerge.js\":\"11a4454e88d56ed4\",\"/knowledge-medium/src/data/blockSchema.js\":\"062117b02674f554\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"f376a9a165fd5ef9\",\"/knowledge-medium/src/data/blockTypes.js\":\"a0e9b389a845cb6b\",\"/knowledge-medium/src/data/clientContext.js\":\"563249dd925a8338\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"b1157a8f86c6bc0d\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"45cb622d8ee2f7f4\",\"/knowledge-medium/src/data/derivedIds.js\":\"c6dbeba86ee78fa1\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"f342a9014c5548c1\",\"/knowledge-medium/src/data/facetBridge.js\":\"5d22f3f9eb123c01\",\"/knowledge-medium/src/data/facets.js\":\"f4e5138fee519f5d\",\"/knowledge-medium/src/data/globalState.js\":\"41d7ac674527b292\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"8b5efcb50e6b1b6b\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"45af3df2642f2b6a\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"d2ada171c2316cbd\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"edba50d40d6d1725\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"2af889693c19211f\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"2579156d74a842f0\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"ff1a946fbd0a5c42\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"3480d4f264159fbf\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"27621c711457af32\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"8660e11ebc76044b\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"e8d9b50f80250f9e\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"1ee1bdcd8e60e220\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"46d26dd5ed729e14\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"50eb3e0044c3a2e1\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"2cef7cf117bc0c64\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"b68e600a48fadad5\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"b8fe4a42606c85c4\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"53a59290fd7ef05d\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"97838b83d626c236\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"c9b542ed8d233fbd\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"14b60e9eb9fd10e3\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"fe088b29477bb425\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"1a146aa23a58866e\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"88c475f0e087ffe5\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b905e76bc2db4062\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"5cdd8d76fbd14750\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"85aa6a2e8436afe3\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"451e7b17e9539959\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"5dbbcb3d29aeb4c3\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"df213ca3daa78bc9\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"a0d39639b231c80f\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"324b5ace929a4900\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"f6dea0ac2cf916e9\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"bf30267f56251ebe\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"f506da5e0914839a\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"a4802b44f87fe1cd\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"674d069d0f46d9bd\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"3aa2af08240bf984\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"8f0ca518689b665c\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"9fa1c944836703cb\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"5a69f49c1dfe3d49\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"9458d8ec85cdb585\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"3868f645687c4be6\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"93100de7a3eb24ca\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"b8a3d76cb64411f9\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"33b4fd3c7f8f5feb\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"2b0b81d22d7912b0\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"dd30423c929fdf03\",\"/knowledge-medium/src/data/invalidation.js\":\"8f2ac652d4bd43a3\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"ebe9ac2d1aa172c2\",\"/knowledge-medium/src/data/kernelPage.js\":\"12ec47e4cf500d97\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"42d3603feba953b0\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"2688e3e0d95655c9\",\"/knowledge-medium/src/data/localDbStorage.js\":\"c6462b61d66da816\",\"/knowledge-medium/src/data/localDbVfs.js\":\"88578281d0ce29df\",\"/knowledge-medium/src/data/localSchema.js\":\"a93c150f36ff6496\",\"/knowledge-medium/src/data/maintenance.js\":\"7a44ce463395712e\",\"/knowledge-medium/src/data/mergeProperties.js\":\"1151b137386d8ddc\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"3737883277736020\",\"/knowledge-medium/src/data/migrationsPage.js\":\"c0b610942fcce0e3\",\"/knowledge-medium/src/data/mutators.js\":\"84c8355c1bae9b4c\",\"/knowledge-medium/src/data/orderKey.js\":\"b7ee57ce46231d3f\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"ad3ce34f3e8f6efb\",\"/knowledge-medium/src/data/outlineSurface.js\":\"cc45c4f68749d0e3\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"9fcde8c2d5f7475e\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"cdeb88418fdba684\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"25421114bff84936\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"69548abb19190ed0\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"acbe281ab2af578f\",\"/knowledge-medium/src/data/properties.js\":\"3922d941afe564e2\",\"/knowledge-medium/src/data/propertiesPage.js\":\"e230b40930c6aae8\",\"/knowledge-medium/src/data/propertyChildren.js\":\"57d46d7ba2b65116\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"30f32f8f6848fb8d\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"8abf255a62f5e6a9\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"aa0507ab1cf92465\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"e61dc6f34d68dd55\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"cedc5d82b77b332e\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"1b99b020421963ed\",\"/knowledge-medium/src/data/propertySeeds.js\":\"c2f08ec852330ebe\",\"/knowledge-medium/src/data/recentsPage.js\":\"98fd58be290bfe33\",\"/knowledge-medium/src/data/referenceBlock.js\":\"92435263c8b34f72\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"3bab80beef15159f\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"b569eaae34acbe92\",\"/knowledge-medium/src/data/repo.js\":\"21b7f2c9e853e608\",\"/knowledge-medium/src/data/repoProvider.js\":\"c196195b1244c649\",\"/knowledge-medium/src/data/rowProperty.js\":\"f0fa1abd55ade9f5\",\"/knowledge-medium/src/data/searchFilter.js\":\"961f30d4ae0b6c5a\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"ab8d9b6a32c50989\",\"/knowledge-medium/src/data/stateBlocks.js\":\"3216f32d24a60b88\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"0874c8356d3e619c\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"95612bcbec536fa9\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"7eccce70dd6f0cee\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"bf04034bd33a16f9\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"e54be98d2e33fccc\",\"/knowledge-medium/src/data/targets.js\":\"3c8a04dcd404b40a\",\"/knowledge-medium/src/data/typeColors.js\":\"58b90055bf217dcd\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"c7773420e8f0027b\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"fdd4cf8345e79b07\",\"/knowledge-medium/src/data/typeExtraction.js\":\"4be3a904e94b0b04\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"b0e32cfe18bff2ba\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"0bef5d557db4108c\",\"/knowledge-medium/src/data/typeSeeds.js\":\"e97056a49bac2f80\",\"/knowledge-medium/src/data/typeTagger.js\":\"9d5057d7cb6a138c\",\"/knowledge-medium/src/data/typedRecords.js\":\"5ecca64328dae0f6\",\"/knowledge-medium/src/data/typesPage.js\":\"afb0f150458ab1c1\",\"/knowledge-medium/src/data/userPrefs.js\":\"46f2896c11dfaa9d\",\"/knowledge-medium/src/data/userSchemasService.js\":\"bd51d763cdbd03d9\",\"/knowledge-medium/src/data/userTypesService.js\":\"c5a78c0eb379d1fc\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"acc9e39119edfea3\",\"/knowledge-medium/src/data/visibleChildren.js\":\"3715aa8b15e02104\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"cf48fcbe97b8780e\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"5ba82241e958c092\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"d91d365fecccfc7f\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"f691c9b76b8a1d18\",\"/knowledge-medium/src/data/workspaces.js\":\"fa08cbe3b5147cf9\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"7b23128bd549a744\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"9e4bf9422a1b456d\",\"/knowledge-medium/src/editor/atTrigger.js\":\"b8af2a58f862a369\",\"/knowledge-medium/src/editor/autocomplete.js\":\"64275e5f5393dcd0\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"6b3d2cf97f49b10a\",\"/knowledge-medium/src/editor/contentFlush.js\":\"869dfbbd619cfd43\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"0a57f75f01e16cb8\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"0c1d778e420b17d7\",\"/knowledge-medium/src/editor/insertImage.js\":\"b3d6b7af708a68ff\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"99d2049a1c89ff67\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"90afb8c791812e2b\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"ac0e42c9bb62008f\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"0e1784516fcdca3e\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"91b7176623a3e286\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"37822fd343659ac5\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"922fcae1a4435189\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"d386956206f7554d\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"e9626fc852c337a6\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"ed5d31855854f1ef\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"590e75cf06cbf54e\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"035a3598f90af7e2\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"f0577021a60706ad\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"ec2e550ea47111e6\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"b84000f6ad96007e\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"00f77b09c688d044\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"bdfb664697454355\",\"/knowledge-medium/src/extensions/core.js\":\"0b6e6aa40c312b44\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"c61a1be77a308853\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"915c282c1672bcec\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"d8292487c162ef29\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"d28376d7f0025ed4\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"a6cfdd2385ad10d8\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"a99ca199b8150ef5\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"09b0a3c6b6e70b46\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"5ccff2439872f5b1\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"ad52b4ec1630eca5\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"8b6c844195f199e0\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"6f8b355588ac8ee4\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"ff34f954117378b0\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"a9f6caa8a7b2089c\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"aa926750197046a0\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"a60fcc952e57836b\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"6ff60447768ddd4e\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"ddfbf666c7df877d\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"edbc54bb4f52171a\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"9af5e06fb39a42fc\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"3d2a1c06bb63677f\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"10c39637556ab41d\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"ddde3bfb13b699b0\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"db987c6994e2a2fb\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"6729cf5b605e95a7\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"5ea87e9ec6174d2b\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"70761e93787222b3\",\"/knowledge-medium/src/facets/facet.js\":\"8d0d53e03f94a517\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"01f1f3824235adf2\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"fb296562ab3df679\",\"/knowledge-medium/src/facets/togglable.js\":\"c1999e9f7f162218\",\"/knowledge-medium/src/facets/variantFacet.js\":\"dd4f8d265df8b92e\",\"/knowledge-medium/src/facets/verbFacet.js\":\"594a8c0080f533fd\",\"/knowledge-medium/src/hooks/block.js\":\"e93469962a36cf38\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"af62e948ba096be1\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"7918d304069842a2\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"fe5ea1b7718cf429\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"27a310f43b095a49\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"6c78233610f509c4\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"806c9fdc7037c26d\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"dc5f2f1494d2e680\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"f26c446b6d51b52e\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"852e24d07cd31f54\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"3d5ac6c458dc0caa\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"7d58883fd9b8eb55\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"1b5db7f7a156ba4b\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"85148ad6ca7cd458\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"66ce9f2cdf193b7d\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"2f289f2a849de70c\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"7058eb68e0444ed2\",\"/knowledge-medium/src/lib/utils.js\":\"70b3789b2686a4aa\",\"/knowledge-medium/src/main.js\":\"7f53d0ecde96dae2\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"3d6b34d6dcb35faa\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"2bb4284d73daf60d\",\"/knowledge-medium/src/markdown/context.js\":\"44d2bed14f6371c2\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"64a5f77a536c7e92\",\"/knowledge-medium/src/markdown/extensions.js\":\"73a979af53a11688\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"778f2118e0077ec5\",\"/knowledge-medium/src/minimal-editor.js\":\"cb7f737776eefb62\",\"/knowledge-medium/src/paste/armedCut.js\":\"fb9ab6a535543fd5\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"7973bdc126151d14\",\"/knowledge-medium/src/paste/clipboard.js\":\"3f325ae7c3b87b91\",\"/knowledge-medium/src/paste/decision.js\":\"fee639cc5c1528fe\",\"/knowledge-medium/src/paste/operations.js\":\"c2d31ecfccdaf2db\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"6175227ed6e6a2f2\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"bbea0e74f372d902\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"39eb46948951a427\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"e8dd846133d35a28\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"90e2d9139fa709a9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b653fe9b23307ab0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"3082cc61f0f85ae7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"5d5b93e896f3ef11\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"9ae56a66b30d18c3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"921d91c616010b83\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"b9d767a043faeeb3\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"84446cd2c14f9c90\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"501c36307994f3be\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"adeda5e81ecd20b4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"01f150f124929f02\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"fd252822699f6153\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"1296da71205a744c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9666239bc04c41df\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"23b3f48021142ff8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"310b86d4f981b57d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"225e84789da9b247\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"fdef810c19743030\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"c1bab3038ec62682\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"826d53e977cf8bf2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"8f11fbb4c9031c8b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"fad6ba60b433ccb6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"9b1db225d8a492dc\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"3db91f9b50024e21\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"8995edbb956298e2\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"aa9eee5172987093\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"bc4d53a3b7006fa2\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"00525a6e1b6c1179\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"02745bfb3d644174\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"ee5d8eb5f4a6330f\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"a87848bfcf554872\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"3768d351443ad4db\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"f6b977121dda9f53\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"a2ecb043de3ab272\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"26636a41cb848fc4\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"0019386b6f90d4c9\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"820ea181fb9b17cf\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"b916aea7ba3ef59e\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"3c06a9d15318c3da\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"66fda17c28f8ffe0\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"40ff820f8aa76a7f\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"524db57db4a448f6\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"0cb90320d1fce3b4\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"5ccbddf7e003fd4a\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"a13e49e30eefd86e\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"3211bdc867528527\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"cb2cff2dc553d7f1\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"b01d213ac208abb4\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"d1e9c764e67310d3\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"e7b35a2e5ef3c855\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"36874d68060bcd43\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"79b7cb43fe328558\",\"/knowledge-medium/src/plugins/alias/index.js\":\"11c5933ebfabe8d8\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"d22e4c228c0e91c9\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"2f570220172d61d4\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"d20430d2cba2a0b0\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"0fbdd0c21216bab7\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"19434e122d7aebd5\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"bc416e59246151b5\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"60038e5241e40d7f\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"eb8d330535dc5536\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"1cb6bde6cc6a80fa\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"763d2d4edadbb2e6\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"ee8712471735de0e\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"f9539cf6bb96f560\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"4f5a5d6df669b488\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"dbab2f0370daacf4\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"49bd67af272f92b3\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"98a5aa8cfb851245\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"a016bfd5dd7023a6\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"ce50e6c7ed4f26b9\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"ad3954be7058c30b\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"e275955bca03f744\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"97f6b5c686812999\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"6a9f0299a714d4b3\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"6a9edd114eb9d57f\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"757a5a252122c190\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"d26dbf787b4d8dd3\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"1743b5c76999f966\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"7bce33797e6d2692\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"d4e195bf5fd6494c\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"5afebb4ffc1f737b\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"30b3d27602eeed21\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"46cd2036cb05e731\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"2d151ca64a4cd417\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"57fd6012df18a78b\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"207c79e36073243d\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"d0c79cb806892358\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"698efc114b071508\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"19c29a9360bce8c8\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"77b498b252e47950\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"9c1ee2c6c756ea76\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"5a6e13f28886b767\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"c6ec8ce7d10d55f5\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"0326602c43816ce4\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"63756f5c91aa5445\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"28b57968cd5a9e12\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"658eaa5cc5bf6464\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"b7c35f43c4b8b7f7\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"89a2ad1dafad8075\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"67b0a5db75d0a548\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"437e77781f93cfa1\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"65d74276c8b21d44\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"fb4c3ddd028be604\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"658be488ed8e42da\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"5fe54ab8599ca201\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"499fb353639dc95f\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"ac98865a95578faa\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f5dcdbe4ab3b4103\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"07efdeec892393d5\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"aef3fdffc2f1ee7d\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"1689605ca4fd77af\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"138b6bd3b080c3d8\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"65398a78cb478f5f\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"12bdf563b7da1120\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"78f39f4d284b31bb\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"cf2ee22718797cbb\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"ce3e554d8902b4c8\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"4263942a69e7f62e\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"ef5779bba3cf99fe\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"26f7e0c1f03c4e5b\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"0a25b94d86ffa9f8\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"a7af2228e0470cf0\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"d03cfc741a0b1c24\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"84d5a5cbef0557b0\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"a728c9478fa0a54b\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"5124549aea52c79d\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"cfd4502ee2df2d09\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"c499fdbd001668b0\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"244926e2f52aa321\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"2d829fa727d3a5c3\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"f49dc41bd091680e\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"72070d153386b67c\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5ba91e3d4e1f0e25\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"edd03adf829827ec\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"5cac8f7afcd7a3e7\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"3b632e3b6063468a\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"6264261566a7367a\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"4eb17fd726da8378\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"3a2c40d5bebb5cc2\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"9914aaa2ee68a80f\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"496335fa5ecf49af\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"440634165f1966f8\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"ee6ce8519468bd73\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"a81a8a3bbd5f8bbe\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"4e6b84c43368d1b4\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"02b371135ca1f458\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"da83b79239b2eb6e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"8fab0ab745220dca\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"0564f301d8afcc57\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"4dfa2e4385570dc9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"72aa4294a140ba77\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"5cf5191eba924ca6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"364f46391d22be22\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"fa8835ce2c5a07e1\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"1c68f1b45a1921f9\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"6e5a0039ac763fca\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"a163bf5697a4d889\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"f1f8d8e00dab40ff\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"b09ca2e2b209c751\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"b4755d2536fbd1da\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"6e0da574fe7f617a\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e7ec87edb3ad362e\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"8c3e506e7a054135\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"a1fd21f26639810a\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"efafa675d6a6d3ce\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"131dd4bed29e352c\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"6a4dd7f32884fbe8\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"c21bd89a667b7fb9\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"25ea6605c7b061f4\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"8f5fa424c9a06655\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"e161b4d60bd8e892\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"ec103c76f4b798cb\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"bbaa8cbe2bdff06f\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"4420d31e81a0e9f9\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"d27716cae0edf702\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2fbe13becd01c84f\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"e156e7369a539f88\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"56b5f2ce8ec73cf1\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"d1a5d7a20cdd20a4\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"9dbf74b405591ae2\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"6fb69836619b055a\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"660928e26d77b08e\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"60b66c6fe9fa9f27\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"97a041405cd7348e\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"69eb182e5d154826\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e49dd1ae4fc0097c\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1e3c6659b228f7fb\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d0eb06edda694342\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"6076d5b7d034f7f5\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fc5800f0413e05a9\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"33491a66ac672cb7\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"848fa2631104a3f8\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"796fe2656b083b16\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"ded00688570b5281\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"dc5d69e1d75d139e\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"f9b54da39bc08198\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"f4486ff520697f3c\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"ad3efb39d78682f6\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"f166c5c8af954df5\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"689f0ebd7fe83a75\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"dd2ac3300ca07c29\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"f5cbc3da1d965f5c\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"ae1f072d685315d3\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"5b4918e2de1fc0b3\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"7fc19f12290669df\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"10a6386267512075\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"b63d578b8127af81\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"35212b07de3b321c\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"a0351f650358826c\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"e3039abcc156da74\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"6d18c318de8e37d2\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"04ddca75a0ac81d3\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"48d3d8982958f0e2\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"2d5ac101d798f415\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"ea02510e1110a41a\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"4172bd8a4494baf9\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"f9ef3576b7c6e1c4\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"d115de90b63e86c6\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"5d77670e920055e6\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"5c32c063a84db998\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"a29d223e70537294\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a5dcafb46e9b47f7\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"abda26cad2c2a6ff\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"536eb8472eee83ce\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"5289f3b8cf11459b\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"694ec91e746e89d5\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"96df5c80b442b81d\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"4839701cde536252\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"8fb8dfa365b2ee3f\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"14e1d8189ad4ec49\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9997bacbe706f01d\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"cdde00e63a2cf09f\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"8b1d2d0f4c20bc2c\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"66df23c11d3c7852\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"d698491bab903567\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"4d1472939bd18d9c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"d0a0940cf649b999\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"ab45a2f811c702f3\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"573243dc053d50bc\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"710a9777207234db\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"beb912a433b5df61\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"50603a6ad799562d\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"124945360c1128fc\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"ccd5604353d22469\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"efb8fe010712df7e\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"feddaa6906a2a680\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"98818d7920fc45ef\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"2977ff1e1b1e1cf9\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"cf08dc9842ff79ea\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"007ebad5e75716b1\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"f1eb735e59b0de5d\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"01be1990ac9571cf\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d4ee6d9b4ab8577f\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"3221ff27790f0555\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"0e8517fb3b786dd1\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"52c8fd891935a580\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"f331c6934d715c5e\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"3e195af7aaacb07b\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"9e4341b009334c72\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ca2c1afade8a82c1\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"fff5d92cf301ea9b\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"9ec616cc49a9007d\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"5223dfce7afb79a4\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"b98585ffce60ab23\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"1b0765405283e334\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"1c7293f11741e1c3\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"ea9d1245908c1725\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"708dfe1e63d2ff8b\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"4dcaece810c23d6b\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"676de1044a94fe61\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"f10ab57dbfacd393\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"08a8136bbbaf5d7b\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"bf985687648bd6fd\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"9fdb073f43576b81\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"36a5464d8f69dfa0\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"b78c2a10c6eb02fc\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"5a626b9f887af649\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"1ea364dcfc81e975\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"20bbf7b146ef2c5e\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"f983d5336c22eb5b\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"0d75e74b721b5e62\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"6a3942fe40f5ba65\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"37f3a76c94f2c489\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"20456aaeb5485f63\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"4c2505039db7dc82\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"ced72dbc42098ae5\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"2722ecab7033e9c7\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"09d448de913737fc\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"60942d23a5fb2f7c\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"c3843500a2ad07ac\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"133a453db638fe17\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"c850be404b5bfdb7\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"41c7e06277a9f1a1\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"a912a080856ccf46\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0cb2cfdc07c3e6b9\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"ac3ac545931751fa\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"da932df750942050\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"118785522d339ad7\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"0c0bcba8e5d4a67c\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"d5a5154e66fc5418\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"cc01cf759e4641a9\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"285d34eba0f3cfc6\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"c960f40cb1f6e8c9\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"b8dd7f224bdcc538\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"6ba17ca375043c3b\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"0ec58961662b6a7f\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"1c497aea808ac595\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"53c006cd83b017e9\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"3871a6ae3d3aec12\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"f69a1ab3ddf0e3f6\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"d20832938f53aef8\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"36f4408ea0c9ea7a\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"76e167632f7db8e2\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"dc84661e745e6be3\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"aef9b9f3028b8501\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"2fdcb8ce81703dee\",\"/knowledge-medium/src/plugins/geo/index.js\":\"5a59f28c80ceae41\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"2fe48ccec103a8a3\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"212e1fcfacfa3fb2\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"6c2dbd145cac9c19\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"19d41432b7ff6f39\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"97638210a489acb9\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"5f30857eb67f49a9\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"b12ea6454bb4b3b8\",\"/knowledge-medium/src/plugins/geo/query.js\":\"fe0751923ecddf27\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"2e15913a272704f8\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"25b05372c24554c9\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"588e4b1e4b3adb9a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a51b00d9cf9735fd\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"ecffc4c690ed35f8\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"8ad9e8ac9a557c1b\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"f3cbde343527ec0a\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"b51fd86ec97a6186\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"262abdc8c1de0e9c\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"8f617c4c886bcd77\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"1a893c45b6660a7f\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"6997b777c268d7f3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0cc724a5455b6c88\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"39e84af50489b668\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"69e0b9627dd76061\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"a29357b017a009de\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"a0e9f1ff583bf7c0\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"8896a2eb19a52c12\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"e5c8d5f1d3fccd36\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"03beafcce940d646\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"cfb0dd3ee54606ca\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"b17cc171a5457f0e\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"06eb8a2013299efe\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"1fd7c2fabab117d2\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"f4b40578b3914842\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"7e0c6f8063c23f67\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"599849dd49b9c723\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"81c613ad2138a1ce\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"6a441b470fd8d90d\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"7026c07ef816c0bb\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"db2829be3b8bab25\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"b390135baef821a8\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"24001cb8533b2e34\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0e6c25f8d5626ee1\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"25efa32028ed1f0c\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"69fe6b53c88c9b2f\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"9f28692631a6f1a3\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"c05e0327beacd8fc\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"47441ffdabfbd704\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"71250e99d89f8232\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"6ce6829d9857968e\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"b7d06eb2cb74163d\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ee7b6adb3e8c9167\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"d8db18ecb6355a1e\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"e4769068512adce1\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"ab1eff9f554011cb\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"1526ee838678ecaf\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"f0229d2649f701cd\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"8837fde49d4025fd\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"4c7c3441f6baa1e5\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"f046c9695589b714\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"bd434e622c1ba8f9\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"919a2e0a00664592\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"42d8f720959240fe\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"5439ba11e8c224be\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"21f0aa99fab94bba\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7df934ae50bb2538\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"b881826dee356b45\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"850e5ec407384571\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"6d2cb222342f49ae\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"06a7a065008116ab\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b2d6b6d177262343\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"0a877d072104e047\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"af7010ab94c8d877\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"10bc40114b07d3c9\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"97eece264dd70267\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"95bd0c2b525117fd\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"fea6cfc5ad202bae\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"e7d0e3bdf9fdb10f\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"3b86af3052b7b13b\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"9f50242b6e8e8680\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"e2fd3717f26de2d2\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"af776ecb2878c326\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"0fb93e5fd6581e12\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"45a8d8a9b4cb27e5\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"ecc6d1034d5c88cf\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"2b4ed6cf5594d871\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"b8d83d88dfc828d3\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"9e4cd54f679e6362\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"bb52328c346f8f04\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ccbe33cb353c8254\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"66de8fc95c3fb764\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"46f8529210aed7c1\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"3cec39de929a4d6a\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"55d545e8a0896c98\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"4d28b03373a44323\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"dc7bb6f2bd3c6935\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"88038402561f8fe7\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"8b9e3c88592714c9\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"f2fe53483354706c\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"daa7a690547f19a7\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"63394ffa735c099d\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"494d3e71cfcf18c2\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"d584cadd10b06c0e\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"4fd3cae3166455ab\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"b90334cd216f2b92\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"09046bfbf88b750b\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"87284a335a3f8162\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"9de5a7437ffb8e22\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"e50e20453c10b3d6\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"f5b49963fa873d38\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"373b0b7aa6f44b43\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"af432b08ecc30f3b\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"2228c0adb502518d\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"ba2de75fc0a09177\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"925d5fcd23dad784\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"51da6be75699db47\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"9fda8c0b71e474f8\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"0b90d3bc68da6d02\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"dc8ed5955398e921\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"5c7218a20d8f5731\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"9e96e1278df71bbd\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"dd5a8772e0bc2edb\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"8dcebf9621fc609d\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"92e037881f9354a0\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"b2375046a354c3d7\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"cef6430e15aded10\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"16569aed9440b7a5\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"f80f5d65dc3e66e2\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"77bd6b1280d761bb\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"bc87dc03e0ec276b\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"cab1a3b46e96c84d\",\"/knowledge-medium/src/plugins/recents/index.js\":\"55bb3a550b058598\",\"/knowledge-medium/src/plugins/recents/target.js\":\"92a4d8666a396c76\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"c067a859cebc4c43\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"95102330366fb7c6\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"912b4932adc80c86\",\"/knowledge-medium/src/plugins/references/index.js\":\"1aa0ce51f50e3e4a\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"784dabbe2d2bdc9f\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"479278e94daf0771\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"d733de4e2d791122\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"e88791c048a4b671\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"12dd496bfcfc4fb9\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"cbcef896d0fccc33\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"7d0b62798ba07659\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4d7aab1d45ca33f0\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7b34c74f0db4c933\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"26312ec0f1264858\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ef80aac9855d43f2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c8b555bdb8050640\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"2ef7daaef28071fc\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"d8064757c2d2f948\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"568f03120d9f4ec4\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"9ac57cbf70ab620f\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"cba70da219979617\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"33668d3f50c8a025\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"a611ccb630452f30\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"c22bd79be8f3e098\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"a1dbcc54d6fe28fe\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a9b2cb61df9889c3\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"87a83c22432b51f6\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"b5f9ba18d99e1594\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"0af761f1cf92e68a\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"33f1ade355dc3097\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"215ec591cc3a26c6\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"df459b94e8ebacf0\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"f9f0ea2f8a7bac60\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"38ac514f82099bec\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"623e334e44ce119c\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"2d18e19a8bb9a4c4\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"1a9f0d7017b329b9\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"29e181b4fe08fd8c\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"9973e8fd047d5d2d\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"e60e62e58d02fbed\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"f1ee1d7b5c1f0718\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"ca2cfcc59c54b492\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"8b0e4fa67df7cda4\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"390bad82d573b1ad\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"32c28577776b6134\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"174183b07da74191\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"c92368acee655028\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"982525d3342d0216\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"ff5806d7e5b2a5a0\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"67a24c4f9b16acd8\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"294bc5cd9db160bd\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"5e3bee455ee64168\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"5ca013e26d754b6f\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"3715b562dc35a5fe\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"a4535e1dfb100220\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"98bb10e602f9e630\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"ab51dea18936bb13\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"2f63f595fb509d3c\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c6813cbe63a294d8\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"ef1ca6045e4f3a83\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"47f15d02a93b4acb\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"89c456ab0c9fdb5a\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"da258d1aac788c3c\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"7e040efb8ebd3169\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"9e92bc94c8688cb6\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"f25d48c677e50be9\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"0006b12843f0e6ce\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"5ca33bb2ceefe5eb\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"ea7e65ad2f63771d\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"4ab6c75a1bff243e\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"6e6fe1453d2ed2be\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9385385f37caa78f\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"cb309539278836a9\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"97e8870fd766287d\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ff65e481c75e9904\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"1ea9a6d0a213acb8\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"482d7c160d1fd16b\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8254c87232df8222\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"47bc01f3eefb7f3d\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"b1dd5a6cedf4ad09\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"6a60d16cea2eb744\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"84a1186529789587\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"29b920b1f07f2d7c\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"cfb1d6292074f267\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"f78a227b8659fc06\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"1ab336da03a2c8b5\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"756e0f32b28bf4a4\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"b5932c695e31de64\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"0ac98312186c742a\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"bdd90e11b125eb0c\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"a49c58b7ff9cf34c\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"b0eca4655f731d03\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"07fcef3c0b8e118c\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"9841c161a8392acf\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"6ce60a1bf0b00604\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"fce085ac88ce0da1\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"366e670605ee7670\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"d421258e25693e90\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"a8ea02b430f3ef26\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"b0e8999b9f872b44\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"80461a266134cb1d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"ec43ebe6947f4a3b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"44b5944ead3ef1ea\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"7565a7ca37ab12c8\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"136466377dbd8a37\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"307acf94d9742173\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"27cd3b870b258c7c\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"2bbc0857206ab5f0\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"eec7034a608c044a\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"869f65b71ff6ae0b\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"7f06aa0983c1c4da\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"3d8ead3419870b64\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"8c92b18df511a538\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"2f77a2f8be0145d8\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"07b44b7b879f0093\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"4d3eba9a006980b6\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"32b6c47dc090d7b7\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"ee56188f687e3106\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"4670994f6b3d2bfa\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"211262e088fd0acb\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"813d4a35e289d820\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"681355bb6fe8edb7\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"a31ad01310394131\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"fcf4e9d6e60724dd\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"bdf83b1f128c3255\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"105f26c951daff1a\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"7ecfec6008e9cd82\",\"/knowledge-medium/src/plugins/tables/index.js\":\"03d8b320b3e399a7\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"31e4e23f37581daa\",\"/knowledge-medium/src/plugins/tables/model.js\":\"b8157d44713f16f4\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"f78ec817d7f4d483\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"a16b7108a83d0e18\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"854ff735a56eca37\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"706b7f78cc54a8fd\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"a1264a572778d738\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"7ea15233eee7c1d6\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"717a9bab3fa5e667\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"c9c19a1ee2a0520c\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"485739e46d645c38\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"3ed481e93feb4fed\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"f7147c97057c6824\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"bf6a5d8518ff10db\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"1a497c49327f6a75\",\"/knowledge-medium/src/plugins/todo/index.js\":\"f047e383b27b80ff\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"207d3db0efd2a6b4\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d9e6fcff9956fc81\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"8f0ca3d0c45348b8\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"0df3a2a1b38a0875\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"6e8e9484ae9eed2a\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"61c1957feb127f8f\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"4dcdfe51f969d7f2\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"0d02b063732c92ca\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"564964754e237172\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"6ae44ad391fa301f\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"c02354917bfdb3c4\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"ba05254fcd92bc2c\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"1a32df85a3afff44\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"9604835a41828aee\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"063f92c76f12a5d7\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"5148dc2bef174746\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"ab38fbdee17c4b8e\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"aa13de64fb5d0ad3\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"289bd03be74deba3\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"f00fbce11951919c\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"1f0679e4cb17099c\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"c1d6cc8ed5de03fd\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"81c6fb6cca3736c4\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"067c1a29eb6acc90\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"c3a70202ca020a93\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"9e358834f5ad6332\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"3bab372e57de1f89\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"8f15d3c169e7c849\",\"/knowledge-medium/src/registerServiceWorker.js\":\"82ae0cf69b7b8b23\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"9c0b2f133361897f\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"28165c975e3bb9ea\",\"/knowledge-medium/src/services/authStorage.js\":\"fb2dcfa1bdecddc9\",\"/knowledge-medium/src/services/powersync.js\":\"669715deab6d9b68\",\"/knowledge-medium/src/services/supabase.js\":\"35ef81826a9b8be4\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"db931c93dba566d0\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"786849e6af852ff8\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"b4ea3bad0c146a60\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"ab2c5e066c5955a2\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"9aa10987cc3d0c41\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"b605d6663036b13c\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"dd5b281a09617771\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"71ccdff8dfeacffe\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"ca2e8e1fde262210\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3580c15b91999fa2\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"60c02234fc46041c\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"e6d391d34cc51879\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"113e69a2cccfcfb1\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"972e88f3ff9a051c\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"14e811cc32695292\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"ecf501d1c0dd7981\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"759ea2c129a816b7\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"b3a947409309923c\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"6de4b3aff86c2fd2\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"fd3954a61d99cfc3\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"7043e72a1ccafef9\",\"/knowledge-medium/src/shortcuts/types.js\":\"4dd1dfad637dc17c\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"c58dbe65a62ec4e4\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"d6c76807b0c773ff\",\"/knowledge-medium/src/shortcuts/utils.js\":\"56192c9ae91501b5\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"283e6f08fba8593c\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"e1bc2d0ea27b36a2\",\"/knowledge-medium/src/sync/byteTransform.js\":\"bdc4f334b1caee5a\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"b01b72d4fc5c945a\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"1c61fa7ea299fbf5\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"bd59fd04dc966164\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"3f47bc985b263f7b\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"b5e41a1ed0ee14d3\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"add8eb8e2ec2a37d\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"41407561c1b2e929\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"6aee6653ba2401ac\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"192081eec6114a24\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"74649e2d75534124\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"04defd3a195ba3a1\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"09b4dfa9d49430ec\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"b616b15c91a983c9\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"5db42b0a657b70a1\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"a2e0fe1988f61353\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"81a48527434f1c10\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"4da7f0742aa96b2e\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"af9a5e83cdce8fb8\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"14101a8dd8fc275c\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"c2e0ba3b04888652\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"95c0324db07c65e1\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"9fdaf6509dce6e2e\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"42024a86f89dc684\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"6ff4de38115c2964\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"fdebcaac1202c1a9\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"b2a8dab0292df3e7\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"9d369245e3052614\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"b64240effd711139\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"29c2f20ee0ca8237\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"c046825d6ca3df06\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"3d342ef3ce2dfb13\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"d72d6e4a4dfb641f\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"fec2cc1eeb15a141\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"521d8575e48ac1ef\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"bd374db1a01da93d\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"09c52a38f4b32d3b\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"f63dbefb133862af\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"474cdf2e1a1af6b2\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"74243e90eb7f2e07\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0d3d4b03726e2cd2\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"c66c595663b050ac\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"31f32087fcb409cc\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"8292e520d0d80642\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"21a49b7b523fc5ba\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"c223f31f2a61bcf9\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"e855c39bc9523772\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"5dd8b5e42bcb669d\",\"/knowledge-medium/src/sync/transform.js\":\"25e87435a086dfef\",\"/knowledge-medium/src/themeBootDefaults.js\":\"688b3429f254a83e\",\"/knowledge-medium/src/types.js\":\"3c393124f5311995\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"2bd08e756d4355ee\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"93dc2b4aa337085e\",\"/knowledge-medium/src/utils/array.js\":\"38f45f4cb6909215\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"66a47a5a9075437e\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"a8f81fb70ee56369\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"ed7911d2ac4718d4\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"5a033a5381f2ba85\",\"/knowledge-medium/src/utils/callbackSet.js\":\"d19e9ccfd614faa6\",\"/knowledge-medium/src/utils/clientId.js\":\"db55b801d6fe564b\",\"/knowledge-medium/src/utils/codemirror.js\":\"0d3412a6504384ad\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"d3011efa91b52c68\",\"/knowledge-medium/src/utils/copy.js\":\"100a70bb911a6d45\",\"/knowledge-medium/src/utils/dailyPage.js\":\"43e9cb07b48bbcfb\",\"/knowledge-medium/src/utils/dbForensics.js\":\"3623a1bbd7afcb14\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"a7d5457c612418a3\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"e184945b22c81fac\",\"/knowledge-medium/src/utils/dialogs.js\":\"30dac9d6ba98df89\",\"/knowledge-medium/src/utils/dom.js\":\"8065c9cacd31c8b5\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"0f8c8a5a9abc8018\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"632daf52d952c70f\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"362a19e91fc36872\",\"/knowledge-medium/src/utils/flipSlide.js\":\"9cb98ce7d32e0d4e\",\"/knowledge-medium/src/utils/fnv1a.js\":\"df8b7ec17c4c1daf\",\"/knowledge-medium/src/utils/formatBytes.js\":\"be3f267b170e3697\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"02c1899d0971e0eb\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"08f6d6c671a7443d\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"c61649c785431908\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"7f187869d37895f6\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"4ed17b76a020b379\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"6209618f3e65b0dc\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"de99665d5f52b792\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"4f4573f8b13c0ea7\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"3a89943e37ba5e9a\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"32f55b85cd6c8dc5\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"7c3f8a8462a85053\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"0deb4bb3b43f8faf\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"e880e9177b8b6750\",\"/knowledge-medium/src/utils/markdownParser.js\":\"6b4ee1ef01d057c6\",\"/knowledge-medium/src/utils/memoize.js\":\"e0f8c6cdbef4a926\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"00af549cfed41656\",\"/knowledge-medium/src/utils/nameList.js\":\"077bea1ade4afbc9\",\"/knowledge-medium/src/utils/navigation.js\":\"4b700d0cfd949531\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"da4597022be26780\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"23f47eac44ea37a1\",\"/knowledge-medium/src/utils/panelClearance.js\":\"652ad433bfdb14de\",\"/knowledge-medium/src/utils/panelHistory.js\":\"37712d7135bcadb8\",\"/knowledge-medium/src/utils/panelLanes.js\":\"f85c3842e65433bf\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"527ac4080f1b024b\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"8f496ea406967794\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"9c994cd4524b89ca\",\"/knowledge-medium/src/utils/platform.js\":\"0f3b45a0c13fd241\",\"/knowledge-medium/src/utils/pluralize.js\":\"5c9a93a6c3c0e3f4\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"0df9504f2dcf66d7\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"c687282d6906d017\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"3d719f082e97a5df\",\"/knowledge-medium/src/utils/react.js\":\"a04759694cdfd3f9\",\"/knowledge-medium/src/utils/relativeDate.js\":\"c33d37d1ee35a308\",\"/knowledge-medium/src/utils/relativeTime.js\":\"7b2968829e8957a3\",\"/knowledge-medium/src/utils/renderScope.js\":\"1860c42ad519db9e\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"63ddc3cdaec92926\",\"/knowledge-medium/src/utils/routing.js\":\"12f9874bdf3d0933\",\"/knowledge-medium/src/utils/safeMode.js\":\"a7d0803a86600e59\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"e51b57309abcc57a\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"108d3008147e28ee\",\"/knowledge-medium/src/utils/selection.js\":\"6430530bc0b1094a\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"2d46f737f414cf64\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"766929131c1a66cb\",\"/knowledge-medium/src/utils/state.js\":\"3a549c65db5fe69a\",\"/knowledge-medium/src/utils/string.js\":\"0e55a32afb5e32b4\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"38a80bca47d5761f\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"f9cdfb3ad273e7d4\",\"/knowledge-medium/src/utils/toast.js\":\"a830bc9cdb1472c7\",\"/knowledge-medium/src/utils/toggleStore.js\":\"65eb0201d061f817\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"66cfffa3989c9f16\",\"/knowledge-medium/src/utils/userActivity.js\":\"cdd43a8861477c58\",\"/knowledge-medium/src/utils/viewTransition.js\":\"793bf317293109db\",\"/knowledge-medium/src/utils/viewport.js\":\"e0c8d932c7277145\",\"/knowledge-medium/src/utils/webLock.js\":\"c33876a16c51c631\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"4cba778e1abdbd97\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"bbd010851a99e9c2\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"3726a3305720d800\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"117197781bc64143\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"e8c30e07dfb0e728\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"a31e44250ad3feaa\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"9a589c795c569be4\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"ace4dea32ec00d51\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"af58a605e9cd1f34\",\"/knowledge-medium/src/vendor/react-dom.js\":\"6e8f645e19213974\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"55430cfa43f76d45\",\"/knowledge-medium/src/vendor/react.js\":\"b6fc9b6f74de6e89\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
