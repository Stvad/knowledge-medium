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
		buildId: "c73e1bdfc1c9-e0877819",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"a1cafb7f39b5501f\",\"/knowledge-medium/index.html\":\"a1cafb7f39b5501f\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-Bv4LPC15.js\":\"ca8812abcdfcbda8\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"cca623f978c50c96\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-71oIpQoU.js\":\"df6bcd36b9d21dc4\",\"/knowledge-medium/chunks/FacadeVFS-Ck5EUrOd.js\":\"8977a51e3b8936af\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BXh5I8_Z.js\":\"ef559fc58da2a64e\",\"/knowledge-medium/chunks/MemoryVFS-ClrA2dul.js\":\"e2621212be6e9ea1\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-9W8Yldbw.js\":\"a03a1dbcc5941739\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BhznRj9H.js\":\"a889ca5c11f2c93e\",\"/knowledge-medium/chunks/Preview-6Hk7Hn9c.js\":\"a71c6f9629d2d4d7\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-GMQSQj6B.js\":\"750283a7464f6d30\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-C4PlnYbO.js\":\"1b4e722203dfae3f\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B57hiS17.js\":\"f49e768ebba2dafc\",\"/knowledge-medium/chunks/react-BxDSf_4H.js\":\"ed5cc24581819c4d\",\"/knowledge-medium/chunks/react-CPk-H8ci.js\":\"ad1e706fc5d717a4\",\"/knowledge-medium/chunks/react-CrM7dnPM.js\":\"f8624450c333cd51\",\"/knowledge-medium/chunks/react-D2jXOXMD.js\":\"fc02d009a4880d9c\",\"/knowledge-medium/chunks/react-DRW4WIPT.js\":\"cb5981353dda7d32\",\"/knowledge-medium/chunks/react-XfsO5THR.js\":\"3ec7d8718077c56c\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-Bq25DHkF.js\":\"55aff6ca38f11ecd\",\"/knowledge-medium/chunks/react-dom-server.browser.production-AgQfT6Wl.js\":\"59379a7754f2e1e1\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Dyb9pTEA.js\":\"24e2ec5be48215ff\",\"/knowledge-medium/chunks/react-zX4ahkxW.js\":\"a4c0b541eecdabb0\",\"/knowledge-medium/chunks/server.browser-jmK3OhLa.js\":\"a8f31352318582fc\",\"/knowledge-medium/chunks/textarea-aqjTILAO.js\":\"96097756666ef516\",\"/knowledge-medium/chunks/ui-DbOiMP3U.js\":\"67c42b7f4b899824\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"225d4f2e9525ee02\",\"/knowledge-medium/src/appUpdate.js\":\"07e085dce0b01823\",\"/knowledge-medium/src/appVersion.js\":\"70c1e3de0c934070\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"e7810ddf0fe608bc\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"184866b67c828ee2\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"e04bd18df3a25537\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"6b37318770327bec\",\"/knowledge-medium/src/components/BlockComponent.js\":\"a728087ee35426d0\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"10617bb4eb17b1d8\",\"/knowledge-medium/src/components/BlockEditor.js\":\"12b2735a23687580\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"e76c5034ba2dd98a\",\"/knowledge-medium/src/components/BlockProperties.js\":\"ebe29a6f25127c4c\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"18683fa08515b986\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"bd078e6c09683911\",\"/knowledge-medium/src/components/DividerHandle.js\":\"6ad64bbd50fdde19\",\"/knowledge-medium/src/components/DraftEditor.js\":\"27aa6fdcd0e8b411\",\"/knowledge-medium/src/components/GutterPill.js\":\"efae9dcadb27eda3\",\"/knowledge-medium/src/components/Header.js\":\"1bf920674fb4e6be\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"c7a36d29bd954b8c\",\"/knowledge-medium/src/components/Login.js\":\"f318e194310a66a0\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"73c7a091b889653c\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"6237ddd576c615a9\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c0a4b3cf67934d8b\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ce614b39c38543c8\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"fc72c815e499c79d\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"81d5705cb7fed4f8\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"f999e268a14a429c\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"40ee4aee3c69fbfa\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"b0fec1fd64a701aa\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"5e2ea5a02d89bc20\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"c05695ceed5088b0\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"d8ab2a1fd88746a6\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"cc9669e73396f614\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"4dcf8cb0b4de5cf1\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"7d18f38c70d72640\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"ded8816d9aef50e5\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"f3a0f26fff0f98f0\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"be47d786df82279e\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"ada2b03f34b9ab3c\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"dff6ef631329c315\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"3e710d2953e87bcd\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"95f450921bceb7af\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b5a7aa2598216c50\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"ed6d8b07a5374351\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"b5df8f9e70d8e284\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"731ba9637620313e\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"76c07798fad11aed\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"16480fa848c9dbcf\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"6d4de070655a917b\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"3dbe0fdc6bdd430d\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"ea03f51b3eea1ced\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"1e3d32e94da04cfc\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"ac68654dc62a3ad4\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"9c7d69d3894931cc\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"193fb57f2c5218d3\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"50e8f65f2e13fa37\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"8a460904dfde4503\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"2a7fc18a8f929507\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"48a46a68510b5376\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"db1ccaf08ec2a029\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"5da0274200cd3d86\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8d72b30df4d8e69e\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"64e69e6bfcb113bd\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"302844f41ff67cdc\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"93d67ef941d88ae7\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"32b45c78b971890e\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"3277d741d2499b41\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"f505e82b20d09e31\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"2e3eac83f79345ef\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"7b41926d10333320\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"6ce5eec3af800078\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"d393a237f3d2808c\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"b297538587246278\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"17e564b11bfbf88b\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"c82bafc49d99af04\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"78b037eaad6a8ba1\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"fb8b95d49c1fd6cd\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"840096949c698a5e\",\"/knowledge-medium/src/components/ui/button.js\":\"d8b24dd946938ff3\",\"/knowledge-medium/src/components/ui/card.js\":\"f7467f5e48f6302a\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"5ca857549f1008be\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"f552f8a21cacd3fc\",\"/knowledge-medium/src/components/ui/command.js\":\"2534f1b23669e332\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"4338377fb81faf8e\",\"/knowledge-medium/src/components/ui/dialog.js\":\"6dce075a2c5daf00\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"2927605079e9d056\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"a90c0c31473dce6b\",\"/knowledge-medium/src/components/ui/index.js\":\"d2b1c91f14ee57f1\",\"/knowledge-medium/src/components/ui/input.js\":\"04f3405f550be9d1\",\"/knowledge-medium/src/components/ui/kbd.js\":\"96a4b762804272fa\",\"/knowledge-medium/src/components/ui/label.js\":\"8d6e7e68169a3c9d\",\"/knowledge-medium/src/components/ui/textarea.js\":\"973aad2f71d21efe\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"4b7440ebac582a94\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"f94ce6ee179e006d\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"a38d26ba13388b9a\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"b0cf8de47fdd604d\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"26ea43dc78622483\",\"/knowledge-medium/src/components/util/error.js\":\"4bc1c3a14e7f55bd\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"3ec95e59cefe0ea8\",\"/knowledge-medium/src/components/util/suspense.js\":\"fdd15b43ec575722\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"21d0527652f6ef76\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"67378f3b3e8315e5\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"3c7991147c905033\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"def9fbf6df5c4366\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"8ffb853209aaa3de\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"547bc8f8a7ae6233\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"575815e249ccf0b7\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"c28f9733abe0b23e\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"dccbf503264652e3\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"4da4f6805cf26827\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"bc682a468eb6bb05\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"0bf913251f06e511\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f40f68d584f8d3fa\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"e14f223de92a73a8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"c4dc0481dce374f4\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"cf8cbad2a5e495f2\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"455b4536eee931f7\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"084e030fd5c1c311\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"ef26f9e374362a07\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"a42807d3cf1ea612\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"2c5992483e945b7d\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"ba1088edfd1d2ca3\",\"/knowledge-medium/src/context/block.js\":\"08c7cf183d343068\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"202217a112c5bcbd\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"c8a7caf4ce0dea46\",\"/knowledge-medium/src/context/repo.js\":\"cbc8d0cb500e8260\",\"/knowledge-medium/src/data/aliasClaim.js\":\"d46c5514400da16f\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"6bb06a4386fcf50e\",\"/knowledge-medium/src/data/api/blockData.js\":\"f133d7c1f983bd13\",\"/knowledge-medium/src/data/api/blockType.js\":\"12c772f287850e87\",\"/knowledge-medium/src/data/api/changeScope.js\":\"c7022719764a08e7\",\"/knowledge-medium/src/data/api/codecs.js\":\"bbf63d9d5a12cebf\",\"/knowledge-medium/src/data/api/derivedData.js\":\"279eca70fe84b9f7\",\"/knowledge-medium/src/data/api/errors.js\":\"344865c6cf17e475\",\"/knowledge-medium/src/data/api/events.js\":\"1ef690c7cdf710dc\",\"/knowledge-medium/src/data/api/handle.js\":\"63a4e4f55d484f91\",\"/knowledge-medium/src/data/api/index.js\":\"5ec9b251d46a9082\",\"/knowledge-medium/src/data/api/mutator.js\":\"442cc1703d4eef28\",\"/knowledge-medium/src/data/api/processor.js\":\"92f05c3699327b1a\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"4a71882ef9d371a3\",\"/knowledge-medium/src/data/api/query.js\":\"1271ff1a656e759d\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"df8ed4fa2c83f1f0\",\"/knowledge-medium/src/data/api/schema.js\":\"63a4e4f55d484f91\",\"/knowledge-medium/src/data/api/tx.js\":\"63a4e4f55d484f91\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"6c3af442321971fd\",\"/knowledge-medium/src/data/api/user.js\":\"6fc826a23ceb7ef9\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"06275686691a8af0\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"fdbf036b08c399ee\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"c096c003e97c2542\",\"/knowledge-medium/src/data/block.js\":\"477a6221fe43137e\",\"/knowledge-medium/src/data/blockCache.js\":\"a6416a6b3ba01de7\",\"/knowledge-medium/src/data/blockId.js\":\"96d175205952b920\",\"/knowledge-medium/src/data/blockLiveness.js\":\"35a3e29db2a896dc\",\"/knowledge-medium/src/data/blockMerge.js\":\"d21d31b76560478b\",\"/knowledge-medium/src/data/blockSchema.js\":\"e812bc23304292a6\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"fd2694e0e9385c5d\",\"/knowledge-medium/src/data/blockTypes.js\":\"be18270154b0edbc\",\"/knowledge-medium/src/data/childrenView.js\":\"21e7fde3bec87b98\",\"/knowledge-medium/src/data/clientContext.js\":\"1dbc804cf400d3ac\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"6f4ef17f1b04485f\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"6bc1a635163ad8ea\",\"/knowledge-medium/src/data/derivedIds.js\":\"d38d25bfa5e73c56\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"9d26d0445ae407bd\",\"/knowledge-medium/src/data/facetBridge.js\":\"df8679fe3eb8b191\",\"/knowledge-medium/src/data/facets.js\":\"a263b96e2474a6ff\",\"/knowledge-medium/src/data/globalState.js\":\"fcf89d010857d71e\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"46e3b3b431dc556d\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"c98e250285a9f370\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"e0a84943f06b08dd\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"8af193de64979e58\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"69d58f4e0af80d03\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"2c489fcebe33616c\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"951480c2d768a8f5\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"16076ed174ae0097\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"aaa1a6454e8a8934\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"04f8c1a82d617342\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"5bfe7eecd97a4f50\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"c15948ad86334a5d\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"640e58751184e5bf\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"e05302b8b0dcc259\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"7aedada7ac45a1f7\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"2196f6b8aaa3ad04\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"f9430c351ead27df\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"bb59bbf013a0cdce\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"79cb516e6a699dfc\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"febd751ff2972481\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"aeb7d7ad5f12845b\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"64939488abe0e342\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"1891c64457372cdc\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"90f6af30810fc8f4\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"282e9cbeb0098465\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"8ecdb9967f77cba6\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"50ecca73e9f283f7\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"3919b5e018e63c0d\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"6276e4be60b8afbe\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"c8b0e153cbedc105\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"1bdd5d50c2168a6c\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"1bc6e97e8d9fa9be\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"392cfb7479fb7cc5\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"10c73ad6221cfe8e\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"20f58c0826fafd45\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"bb1cbe21ec16d21c\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"80379cd3bd1067cb\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"7242a8a71c3586b1\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"8f27367ff152e728\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"bbfebbfa06296b22\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"56941a3fe5ec74b6\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"226fd3a9c1a1978b\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"c9c75cafaa6b36cf\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ab57f8635c47c7b3\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"812050afbb78e555\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"e5fb74f498abfadf\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"5a0ace0df122ce0a\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"1482816a103cb9b1\",\"/knowledge-medium/src/data/invalidation.js\":\"ad4f59f462ab5503\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"ef15bbdffb6cf2eb\",\"/knowledge-medium/src/data/kernelPage.js\":\"01d22ff8eb306a63\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"bb39e274f1ab81d2\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"729c79d5807d4a24\",\"/knowledge-medium/src/data/localDbStorage.js\":\"95002d612613ba2c\",\"/knowledge-medium/src/data/localDbVfs.js\":\"6087d6f009c29906\",\"/knowledge-medium/src/data/localSchema.js\":\"b547b150b6fcf7c4\",\"/knowledge-medium/src/data/maintenance.js\":\"db028e3fb0c67ad5\",\"/knowledge-medium/src/data/mergeProperties.js\":\"177d86d1bec0d7d4\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"613fc2448ffd139b\",\"/knowledge-medium/src/data/migrationsPage.js\":\"1d92bc6bab651ff9\",\"/knowledge-medium/src/data/mutators.js\":\"d40a5ff282d67c72\",\"/knowledge-medium/src/data/orderKey.js\":\"df4616d5248261a3\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"c9bbe7ab1893c3d3\",\"/knowledge-medium/src/data/outlineSurface.js\":\"3caa139c6e05cd7c\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"4733fd6dc8641a70\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"4b1c97fe76779397\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"d36b2d7bc77b82ad\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"3c6475619fa517da\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"403ef827f83749f6\",\"/knowledge-medium/src/data/properties.js\":\"533a0a117f9d8ba6\",\"/knowledge-medium/src/data/propertiesPage.js\":\"7a3bcc2e4bec0c02\",\"/knowledge-medium/src/data/propertyChildren.js\":\"e8f4ff31eeb9b5c1\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"0a1a58d77b77809b\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"859eb59d494522e8\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"2ef564b29305f1a8\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"080948a0d63e2557\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"7895939c3a8d3e79\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"27f1dc69fb40d3ad\",\"/knowledge-medium/src/data/propertySeeds.js\":\"0eedf60c7eb5179a\",\"/knowledge-medium/src/data/recentsPage.js\":\"c17a35a282e5cc13\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"e24c87aa695ece7c\",\"/knowledge-medium/src/data/referenceBlock.js\":\"3816f9399f38cfe7\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"d673ff272d3e7366\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"811bd53088b11db3\",\"/knowledge-medium/src/data/repo.js\":\"0ef48acfef92bd0b\",\"/knowledge-medium/src/data/repoProvider.js\":\"a1a004c5ca190fca\",\"/knowledge-medium/src/data/rowProperty.js\":\"aaafbbc408915105\",\"/knowledge-medium/src/data/searchFilter.js\":\"9b4bb95fc5b17347\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"6d96ed8987663515\",\"/knowledge-medium/src/data/stateBlocks.js\":\"7b963e2a67a22ed3\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"ad93d6899980178b\",\"/knowledge-medium/src/data/structuralInsert.js\":\"b73ab7a312b9f9e1\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"6ca6fd92c62fb8c6\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"1392aba82088063e\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"46f506bc70e7c0a3\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"cfc0fa331ee6dc44\",\"/knowledge-medium/src/data/targets.js\":\"d96b743675002c14\",\"/knowledge-medium/src/data/typeColors.js\":\"30ebffa7c9cda2ee\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"b124844ebc798cc5\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"968869a43e43773c\",\"/knowledge-medium/src/data/typeExtraction.js\":\"6c5c8b41e59135d3\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"d500135cb0ab46df\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"f738f3c56cac34b7\",\"/knowledge-medium/src/data/typeSeeds.js\":\"3064ba33b2ab5781\",\"/knowledge-medium/src/data/typeTagger.js\":\"51a84566ae627717\",\"/knowledge-medium/src/data/typedRecords.js\":\"f95de56e16e983c7\",\"/knowledge-medium/src/data/typesPage.js\":\"b0d5697bf94ed872\",\"/knowledge-medium/src/data/userPrefs.js\":\"c3df3d20f6b3af0b\",\"/knowledge-medium/src/data/userSchemasService.js\":\"616cbc66b2a38bae\",\"/knowledge-medium/src/data/userTypesService.js\":\"079f68fb90c3813f\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"4ac3b56c0e24281b\",\"/knowledge-medium/src/data/visibleChildren.js\":\"3b57d24064d3174f\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"e8cdd9c3a969578b\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"7de31fd9351bc227\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"5079d217d0f6ca55\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"df7f19c2c783d1f2\",\"/knowledge-medium/src/data/workspaces.js\":\"f3636451988b3362\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"ae0f1770e11eb7ea\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"f5fe1612b553dd30\",\"/knowledge-medium/src/editor/atTrigger.js\":\"45ed0cf8ca65a5f8\",\"/knowledge-medium/src/editor/autocomplete.js\":\"1c7a1465f75ecb0e\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"7d9bfae3f77531c3\",\"/knowledge-medium/src/editor/contentFlush.js\":\"fc4ed2ba6fc03841\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"026c558b2693338a\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"a407f2ef2eeb577e\",\"/knowledge-medium/src/editor/insertImage.js\":\"07110589384032e0\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"b31177392df3c1e8\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"544cf029d090e741\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"6cfbb49837aba0f2\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"d30c464a697bd926\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"faa692776fe91762\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"cae8ad1be5a1f5a0\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"2686b823b70fea82\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"623f87e67021595a\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"8b2c61242b2e5c33\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"b6897c75a37f98ab\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"20e183a106ee48c9\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"3cd0b2980b07045e\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"1ea3a5a311588b22\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"84f5006f1eb74719\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"0f34920011cb0cc2\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"cc8ebe8f3dd1e1fe\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"061ffd2d2c24c3f5\",\"/knowledge-medium/src/extensions/core.js\":\"4488c6fae63930da\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"212eedd608c36857\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"f00107b3ef23ca4f\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"37cb674b3ffc5a40\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"2879dab10d6b0ab0\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"833805fc4de93334\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"884829d7f3df43d3\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"fc9c299daa6aa84e\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"623d0135cb398810\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"c1a739458d15a246\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"5a3710a77805a545\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"6033105d302fc5e8\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"4371c09aa18c7787\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"8bd8bfc4d4a916ce\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"e9954c63c302623a\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"982bf71dde715911\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"1fb8f579b0a20dd0\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"40184536e9a93668\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"7570ffcd5c2af962\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"5e6334476ee9dd77\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"c82edeaa627543ca\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"21a756c49b91cca5\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"ecafc72e92f357bf\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"eaa290058ced88ec\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"c555ed60fc8559ef\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"53aa9133a345bbe8\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"5e55ad6dfb28db29\",\"/knowledge-medium/src/facets/facet.js\":\"4999fceb7f3cf519\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"d54443c540d45d0e\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"ab66e2e7a8384cb4\",\"/knowledge-medium/src/facets/togglable.js\":\"fc8175bb5b2e09de\",\"/knowledge-medium/src/facets/variantFacet.js\":\"ed12ba02ba85642e\",\"/knowledge-medium/src/facets/verbFacet.js\":\"d313cfa074607510\",\"/knowledge-medium/src/hooks/block.js\":\"ea9b09dcfdb1b986\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"c0abf3ecc5669065\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"0d8651a6028ad20a\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"27ebaffab07269eb\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"728e5287c22d00ad\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"104194beef05526a\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"de6a593b37c69668\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"d43a7530f5417a89\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"18ebcd3e208ffae1\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"f2d57b843c1aee7e\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"248e9682ba23753d\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"d06fbf50d7323778\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"8c7a8619f0c1c7b8\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"20d76a13f55ba0a5\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"2dcb4bba1c4f0fbd\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"5410be1c14b9c809\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"52e143f8f138fe51\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"263043f8a3091fa1\",\"/knowledge-medium/src/lib/utils.js\":\"0beb61e65005d4d7\",\"/knowledge-medium/src/main.js\":\"87d04dc8a43df685\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"1621e24dead97767\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"8aad382cd11f0b21\",\"/knowledge-medium/src/markdown/context.js\":\"dcef552add5a447e\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"7c052452d7814e91\",\"/knowledge-medium/src/markdown/extensions.js\":\"c0e2a9c699a34c6b\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"bd09b30549eefa36\",\"/knowledge-medium/src/minimal-editor.js\":\"0f80a1f5e28f1d44\",\"/knowledge-medium/src/paste/armedCut.js\":\"df59818dd0eebe9b\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"a2b9678c7e0b856e\",\"/knowledge-medium/src/paste/clipboard.js\":\"b390f4e0a2f079ae\",\"/knowledge-medium/src/paste/decision.js\":\"6453897d9b1d3e1a\",\"/knowledge-medium/src/paste/operations.js\":\"d5d3ae8f0f367d06\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"663612b767e10aff\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"354f8e3cc49dc864\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"abb74b2921598d60\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"55fb3bb8d9d25078\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"8c1884b615456684\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ced3f284abb5ee57\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"64a768a9a3b77979\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"10d713002d6be925\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"00e03dac49a965ec\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"febc2238da8db539\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"94005d9289429554\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"5b6add5b8d824f48\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"81128727425bd5e7\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"6ba18cfb4c41d884\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"32f95d756b7322cd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"eade7952bc68907e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"073d51b7c865deaf\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f5f1e76e6b2cf27a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"064789343961e3e7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"2e250d0536b1b721\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"7b0975e626afec0b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"ef0affea77c85b28\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d180645ca63b0905\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"6774ed2b1ff8023a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"60789c140d367821\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"bc0006d47f80344e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"115db158609578a0\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"e16d7a93082134b5\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"f4a64ce0e23873ce\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"b083c7519974c1d9\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"9238d8756aed7c22\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"c1c9d094e52a2504\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"028c2d0f3c37eeed\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"8294a03ad8069ae0\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"1b84770b4d6e39f1\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"9eeb4ccc3af1d7ae\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"b85aaf7791b03a5a\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"01f331f09c0492aa\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"90b971cf9d9e2e81\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"73431b627d6f6984\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"df79fad13d19ff00\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"7badb667931a33bd\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"48738c98eb58f89a\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"eeefea3cbfb227bb\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c422fcea5b4d9595\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"34fa05dcca2b7120\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"fc0820831d21fa56\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"245e6874252a4801\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"155ffda171ab4063\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"476463088e8807ae\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"bb3c4c08bd2945c3\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"370b90cefc091d7d\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"d7ac32168a405600\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"89ce9c2a00168293\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"9b64c884892a53e8\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"3526485f5bea9da0\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"ce25c82c26f56d94\",\"/knowledge-medium/src/plugins/alias/index.js\":\"f7e9a8a85fb1916c\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"51393477fccce6c8\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"8620766b9d8b232b\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"a944659ac2ce0e69\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"316791b80231ceaa\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"5a0c31dd5a36a8cf\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"7e3e5e8d27722dbc\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"e42a231e23cebf0d\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"b47744675cfbbff6\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"f3fd083e55a68e63\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"23112944a9abfe21\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"cb13d36c445e306a\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"512a98ff27bad7bd\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"e1af55d577a9c086\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"97a41fdefe591a52\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"25606e7397ce0914\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"553667f3b5ecc343\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"d2d104da4c419bde\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"62e650449fc7a52b\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"a3b58705cb75883b\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"d954f001438d4f7d\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"8e4ad33381ad9db3\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"af7f30841731eec4\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"6d125e5c62a43abe\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"b29617edf2737133\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"20c3b63b1049ca9d\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"ac9d3cd91ddca244\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"7406b645135ce1d5\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"ef91d2563abf0269\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"f241ab9b4481e1e2\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"9f73ed24b52f1b84\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"eba1a5b7235d9903\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"2df650d1cdbfab05\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"4f5875666e667d62\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"44be336b621a5d3b\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"12fe563916347b3b\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"7934cb7f3cde71f7\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"3c773ecafd897ec5\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"b37941b630537891\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"f21724e529cd2155\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"abefd1d185d48a76\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"8799436e0f9c11c3\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"1224d91f8357f96f\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"075d05b67a6b99d5\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"4e84f86178874345\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"cdb069b5e178411e\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"37ec5e9edc39261d\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"1aa86323c7d7041b\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"57deb0d39ff52e61\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"78abcdb686c1d07b\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"cfbccbd27c6ae647\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a385361e431e45f8\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"97137b31d0c76375\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"ad7bd1dc62127d3e\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"e27d2259c8b2793b\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"f4ced08cb0cecf08\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"096738cc8081055e\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"1cd62963fc386f3a\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"07f6c5d50178796d\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"a9506b6f6342fd9a\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"9e7088ccbbf33b64\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"c57177f938cb8532\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"6ef3bbf80c802e52\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"ef28fba19d5c3d86\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"4e1db3562304236a\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"bb95921bc1590b95\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"484615cf18d0ae51\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"ef4efa2b3bf36037\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"9eb49334a9c17d79\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"a49bf9376379f620\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"4fe7a9c7190761ea\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"f5ab0a5dbd0799d9\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"0288721b42bb5f61\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"56ee8512d1983c1c\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"e5d6b9102458a750\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"15ef9744122c23dd\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"b0d59cfc747f3b9e\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"70310d5ae7324556\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"ddb3d57cb0ce5739\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"516c8e3322424c4b\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"9bf973f6453d9094\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"b4e22b9db432a796\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"8e510b96330ef40c\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"61253723fcb2efc0\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"59fe661b98449c79\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"25b403a065bec045\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"a6455c8ec3e3b7e1\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"bba2e9f3b6ba0ff5\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"ab3deecb7b63e224\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"229b6720077e56cb\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b2f903be2fd7f06b\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"026a7eb4f48ef52b\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"b1d77ec7ca44ae8d\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ba34db0928900e10\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"83f3973b5ae1548a\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"614c8f249299893b\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"0ffe8f2490236b3b\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"5a6b84d0d4116c05\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"9ab925612ed0a5ae\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7d84bdb976f599bf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"2981b1bb3350d209\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"3f66873ceedf1360\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6adeed812a32154a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"6881af92cd035567\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"7f6147b75f1e98de\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"bc04c657267d993e\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"38674fae0ef2a2a4\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1396258b70800f85\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"6abba808f45102bf\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"2988b33cd0457f3e\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"487de5f7f8bf4399\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"283f276603f14c5f\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"7b4c51e7a5bc4958\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"fe41dc38b8c72299\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"f726f0ef9bee235b\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"3d80c1633e5cc72e\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"a8e2775cdff41bbe\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"4a350cda2dcb106f\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"7542997e9a414152\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"365d199731a0ed43\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"46aae3422e84e458\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"27db5aab86ad1be8\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"fe2a0f603c1618c3\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"433b1d8502e2ba2e\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"4e3a08693a7afe63\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"efdfd40468083558\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"ab3f35f632ce1a8d\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"07274cf3d0c288ac\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"cda2ea8ebe1695c7\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"fc9f94bdd5459cb4\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"7c11bd69d3d5b314\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"bf644cb2a4514bd0\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"82fa41167f6c7a8f\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"d2cee50bae1afd17\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"1268ef2702f65db0\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"fe34c1146ddd97e2\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3a535fe67812657d\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"746c829c298d116d\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"588f3ebe6380c4ca\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ff903a25030619dd\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"aae604f67aea1869\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"a588aa540eb853d9\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"6da41d55cff62682\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ee9387908111a40e\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"c7a3efe861329f36\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"8a5a5d28192f7fb8\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"4138bc7a14f9be43\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"985b9fb13626b589\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"0944d3d945746165\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"0a20fb3ce8d089b9\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"36c01a63fea8ddaa\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"8c9afe4e5c761df6\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"25399bdd43c467c3\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"5b4984bf8f96f7e2\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"fb2a9c9513bedb74\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"6173c777505221b9\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"91e113c610553c4a\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"99cddaf140d73ea8\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"b76121d0fd9adcd3\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"8d7653144bc6d9b4\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"62a5024602599842\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"dfb36e0c5c5fa88e\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"2e2d419028d6fb5e\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"e33ab866cc48304b\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"ab7ad7dc98e08b9a\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"3afdde988062cba3\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"e8d42f3060450873\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"fd11db8c55084df0\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"223ec8b63899af1a\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"5b97b1da3a48bce4\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"a2abba0bd629e378\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"064ba0b6fa341e1a\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"db45c0afe5f06fad\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"cf3a676980981c15\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"24fdb6f7f8533438\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"d4aedfcd374395be\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6a17cc22e9a3f230\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"451746011c9c5b29\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"9ecfdcfe1c998a5b\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"8357ec632679eeac\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"67124933bb679a32\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"f0ed4cc8fa37152a\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"366b7a37033eb6e8\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"29298702769ca470\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"99b4c124905f9b0a\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"b31f68112414db1f\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"4d89d23850c0f6c4\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f9a148c5a4f56c1e\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"af9ad6f44469d5a0\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"9b24dd08ec2e44b0\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"7037410916fd6dd2\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"00d660bbff1838d8\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"2e7a6b78ad6858a7\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"b3fe9444a4895cfd\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"dff73281f1bf1c80\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c66d35ba64884ece\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d9c7230b9d1bf3b6\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"810c814d01bfd019\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"dd37bf017b5116fb\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"02cdaf99319d267b\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"90d422b70ce24d8a\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"28f792edc2246843\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"9c2b14bacb5121af\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"5d6805e00e9c82b6\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"6dd213a96689e36c\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"711dcf3879def4c0\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"4315ac45523d8692\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"2a0c38cdfd69046f\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"2ad02cd3a6440781\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"00f8b90851398843\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2bce4b384f3fbaac\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d3bde52516206380\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"c0b3bcdc8c71698b\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"ce5b4676077ef6df\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"e5b4f989db007912\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"33e6a43010327e0d\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"3b912a5d2d594c6d\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"b7979c2b14512dc0\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"eaf3023b3de89c0d\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"4ffa7b9bc37d8aa0\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"3f2f4edc83f37dae\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"99ffd16b184be180\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"5c8968306579b77a\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"c1c4182bf7668e1d\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"f53f4d02a2a7eea5\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"3e5483bb5c7de51b\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d304318d40befbb9\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"8a3c385ca938179a\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"c498a14ea65a6942\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"476d092ca2345ff9\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"536bcadf44ac1b03\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"ae7c88d8706084cd\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"2d0c2641b3c3625f\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"6add7a01468809e5\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"4c838ebb70422f50\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"eaee6cfc2500ad65\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"56210612aa95f38d\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"a99f31f171ef3dd1\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"a978270b581f1a3e\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"5499ca0f2e432cf9\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"68ac69248e55a0ad\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"cd55931a80b63d0f\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"59da070c8a21ae55\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"973f1b94923d5ffb\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"fba6d283cfedee0c\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"4d61d49bb678a600\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"959077ca13b3b999\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3f394580e5e79ce5\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"3fe2481b612dede6\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"9e42d8e4f78d049b\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"9102a9a1177919c3\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"749573042cb5979d\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"899e7749160e60ad\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a45b3bb3b5943b0c\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"e4670107bad08e3e\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"61dc62f8c8fe7328\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"aba3ad0b1fd5d973\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"830eefa7233ce803\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"1d12eb22e875f1c4\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"39dec9562b7674fb\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"55bd9a070f6329e5\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"aed12d5d44903475\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"e6d241fab4cd64c6\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"d7a45def4469c33c\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"3fe811406509c55a\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"d82cc1c166d167e9\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"ff6af32aa5c71d13\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"c59e1f0a9fe862b3\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"2db80f576fbab3f9\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"f20a8940fdc59c29\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"6cb1e4a87d2ad8c6\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"7058f6305e7b219f\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"14d987633119c023\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"109848c8c8e93eff\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"5c9c942eb9997117\",\"/knowledge-medium/src/plugins/geo/index.js\":\"d179465bad87b481\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"b5feab6494c32c1a\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"15312481b71cdedf\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"99ac9dc687e4676c\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"a1c58f7fa144fcdd\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"8b10fd56f9b00194\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"1196dbaa1dc455f2\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"e01b412462f020e3\",\"/knowledge-medium/src/plugins/geo/query.js\":\"87d9236236dfd574\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"68de7fffc17ea35c\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a974dcb2a9c7aab4\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cb34e651262b484b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"30e429652024ee9a\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"5fc18b1301365dae\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"182b0d461f7e0f0e\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"e20264547b41eb60\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"8c2d739a1817b92f\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"ebb70da1c90fa74d\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f69f615e8781d812\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"90b57e537321f5eb\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"6bfcec5c731323d9\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ac38584db5d9d89a\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c8420b28d75cfc0f\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"ec53c02912f4ab8d\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"67560ab973da2a57\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"4b1d0aa3acd974a3\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"0ad8bb7d1f3fd308\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"92e665d308545118\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"8242d4c7f1a9ddf3\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"0b7a975dd8bc863f\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"a5464f04fc126427\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"d9ac775f0a576607\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"6ac938c6ee3057f0\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"04c6f356c838d8f6\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"8df61206f882aa78\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"645bf59ff400a12b\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"2f24a454e212064d\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"d2edbf5458030288\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"ecd3cb794ae2ddbe\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"3ca66d1cb236b4dc\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"3ba980fa5de1584a\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"3eaaa1a227ee332b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"8f9c124ba9dc6577\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ff59c1dd8e69242c\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"f132a82e72336b73\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"9e0d4ac7b94da306\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"5a158796ff342b48\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"62910c2511d4934f\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"5ec0c10fb98bd411\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"b8ae8f9287eed9aa\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"def433ebd4eb3155\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b9acfbf911e6e01c\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"ec3d726bc1234fc2\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"3e625ee567616b18\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"2248123d448b4c27\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"d7ae1e95ab9d333c\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"9dd775975502fa5a\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"55c5eb8aeb0c5e2a\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"8cd27fac87b3fafd\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"1976a1a28508aac5\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"929dd301321b7e05\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"8bddecfa8c530efa\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"65c8a51330ccc2a8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"b4b2218522d712d4\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c96639dc8e4a3c4c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b079cc4e56c17365\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"249f18435d93be6b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"2797733dce3e04b3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"58f3c6a0182dc6e6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"70a4776bccf1f52e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"de6d43ea6ac6e3ee\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1cab56904b9606f6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"7efdbfc63f910e88\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"bafce3c7888c3303\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e029be6c90cd92ae\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"a5c12e86390cf0e5\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"4e39169f1bc759fe\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"37ea5275c24a174e\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"dfc2f9f89a694907\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"89e15bbc625d3288\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"22611b2be7f44540\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"da9cc8ffabaef89a\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"c64fccc163391e49\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"6f8f1ecb71e5206b\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"2de2057a2aff6142\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"1c04b64fcc62d2b3\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"50001574e7c4ef95\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"3fc0c7df28a8c2a9\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"e0c2e3a5af71d600\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"17995f803ca02e4b\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"ae89df45f83231e1\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"57e1c209d2a2b3f3\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"580606e227a9b69d\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"3a15bd4e933ba407\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"f1a6ab2da8c502d1\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"3f1f88c27dc40bdc\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"ad26b641b53e3153\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"5c46f60e63cd556b\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"35c7a7ea9452a2f1\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"09e088888881b5a1\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"68ffa3a301aa189c\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"3f9e09e1429c6d1f\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"1a582a2265ffb0a2\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"28c31e6278c3e550\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"60271a339ed39eea\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"fe5a5a015ee97e67\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"b59fa5512c86f92d\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"1fa8081a08670549\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"37d155e7bb8cbdef\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"121f0e30cb5b1bab\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"d3d32292e74d0ad6\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"b134ef5c13f246bd\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"f863de5f64c02c39\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"f86e9ba8e0d428ec\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"aff6f80352ca716d\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"2f12557acbcff378\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"6567c3607384f0c6\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"6a57f11b05853d4f\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"6a6410b9bf705121\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"96eaa772ccc562fe\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"799d4999967b5aa7\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"c5e487af64289735\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"b90f888d3871c6cc\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"fecad9b0236ab81f\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"105f3c27f7d6dd8c\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"4a0700c65231c747\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"57dd3f9f4dea1a4d\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"1a5521f6b81acf71\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"7a4abd927ac689dd\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ce2521c92bb2feb3\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"f352f2c2415020cd\",\"/knowledge-medium/src/plugins/recents/index.js\":\"9debe85b76954198\",\"/knowledge-medium/src/plugins/recents/target.js\":\"42c5965036b2ef92\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"3fedfc8d5fa1dabe\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"c7796adbf6418115\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"9643db1471466dc9\",\"/knowledge-medium/src/plugins/references/index.js\":\"ea5c3416b763586a\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"93021662720af9e4\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"d30c2ceac14cd132\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"d64d56303a99f984\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"cbb9e23fec04f99d\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3dec35e58c51f677\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"625eb03c3af29dcb\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"49976752b0835678\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"31255118af92b174\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d902dc9597efd24b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"f5977f98ff154ed2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"805aa8fefbff236d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"89bf399e099b40aa\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c808cf556eec999f\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"0d1f5ee6a70a4058\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"8dd05e2e1139809b\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"6560095532e38217\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"d4fc346e831684d4\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"f0e964ae929b35c5\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"49a4e3004032bdf7\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"8c58a773da77a3cf\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"bdeeec1779155f6f\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b14f886055e0f5ef\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"81eb27cc9efa9c27\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"74098f1496d1b2c3\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"2ca5e620d04257cb\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"4569280b0ae6ee1f\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"ce7afd1e5f68ff2f\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"7d2d5990a676ba89\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"f4c127cf3fdd6bbc\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"2a37130986e6ca57\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"1ca67d77cd64777b\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"143a51696c0640b1\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"11244f3c4bc0aa23\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"c6d31e290021aada\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"2570578d50beba96\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"f651aeba144476c1\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"548cb4858236a017\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"5db2056b8b6e7196\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"49d3bc05a0d5b94c\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"a3170e95675ebed9\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"d564d8fbebe7153e\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"d8d93cd8a2bf8155\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"8fc8ccfb2ccd733a\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"f4f987a8e6ebcee1\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"84609bcd9bf6eb08\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"f9e7e19547ea2ebe\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"dbc3c6fdb86b0e32\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"0b1476a8ffcf6ebf\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"71f9288d1b45b71d\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"7568ddc555dc2ccc\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"ac2a1bcddc315cee\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"540502c36527ba5c\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"34b97c35ff75bb68\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"66f18a75dbb07c75\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"19869853344f6d62\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"7988f266398bc7a1\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"1d427d37fd3ca57e\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"9a0af97642e0492c\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"cf45562838b65faa\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e78dba3c59b38fcb\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"7a7f54ce4c2cc4ce\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"9362c7a32a614b06\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"9e5d1d45817fd2c8\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"53cdc3db4c343e65\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1e51222e199eaf82\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"aee72c6de2f9f81f\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"c4751181c6e9dad1\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0a3a88f6b318ab05\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"18a39b0353852c7c\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"d054c40915522aa3\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d1d687eef81fd934\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"3cf7c37dd7b0c4ac\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"b54dd2276631024f\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c3db1fa57c55aefa\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"6ffa20e43fb6f513\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"635c6542d462248d\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"bec86fe694614bed\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"8879c9332db77847\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"200e487252e5514d\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"062212777ca30323\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"d3b690f84b8e208b\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"be58912464c06df3\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"a048e00dba0f6d9c\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"ce60cdc03857004b\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"8feaaf9344a93a2f\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"7e57b2d77c8a826d\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"f21320e4fe720ea4\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"e9d7599c2c49a3ab\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"0d4ea74055b9222a\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"781159674ba4c656\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"4aadbda5fe964701\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"73584e7628b20290\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"e7cc3fffd9bdc021\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"409aba7d033f0f43\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"fa88d20b88c6ae41\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"5e0780420dec2292\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0d8d8ebc5bd9d71d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"6f311446f59fe703\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"f5ac775a78e6f5e6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"4350362bd99cf8ae\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"e4e3a348f86e308f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"5e61b35b2fdc2fec\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b8c61aa7e0b3c679\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"539248613224ed38\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"be760d5193a43da4\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"c4a2cb051a1069e7\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"c1ada1ef3b059cf5\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"41462c1e526fe300\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"e3ac6daca4d24636\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"740a11e1bcdd2ec0\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"2c59e1c5b1f77c55\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"fe4f61033afc121a\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"be0a915cd457f490\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"24cdfcfd29e915a7\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"2ce871407374102b\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"0a5a61cee4a25bdd\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"61185f36750108dd\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"d3f8868be669dfaf\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"bede6ac1f5048823\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"373aacda90017751\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"2037f0bbbb25b609\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"bb9b3dafc6176bbb\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"170c9ce911387a59\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"5f0fc93705337abc\",\"/knowledge-medium/src/plugins/tables/index.js\":\"2cf7cda057ad562b\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"f7fb675ba3e73d12\",\"/knowledge-medium/src/plugins/tables/model.js\":\"708b7d15819c7933\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"ef58c97f75a52202\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"a818d3e50e509fab\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"19aebaef29b1b902\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"049e8c5c3262fa16\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"0e3c1bb1bb0f30fc\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"6bbd918d910a267c\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"0cc21dc18ccbe55b\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"659adc9a57810330\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"e82b5c6ff5fdc19d\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"9249270b9c0e7943\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"598c1026f1fb4c23\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"202e3985bbe2ffff\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"4eb52d36f52ca17e\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"d0a611ae292143eb\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"003ad8cca6a34811\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"5579956a46093be7\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"77f996db5185dec7\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"c8887894a76861d6\",\"/knowledge-medium/src/plugins/todo/index.js\":\"9ed0d64d22de86f3\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"20b86d045eb9d7fd\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b2ff88cb5a78ea5a\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"a8efc9ef5401f26d\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"f429d2c6b3a195d7\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"d55bd413f7da0a3a\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"00b6d50576ef3ea4\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"6e80dad8ddcf451d\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"15bbb10020550342\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"8fe952b66931f859\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"6a076f2c99a31cef\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"9cc4a695b524e4c5\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"686a4aeb8aa5b006\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"382c536c41d9ae1a\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"0ed75f2996f10f16\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"fe67c77d95a8d3b9\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"6ab0c6ed00b8e47f\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"f0d82f6b25dab4f8\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"25c63e6f85543a10\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"de5e9bb0f1d4b492\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"347dea75719321b1\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"22dccfb8fdc524b0\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"405ca4e99ebfd4b1\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"a6b25768a4deada8\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"e7e9283688aeab5f\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"f62af31bef0be077\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"a70c9e3197dbfb3c\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"f717df97423d1bf9\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"686f524ebec63445\",\"/knowledge-medium/src/registerServiceWorker.js\":\"6a4c002852c82ecf\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"cc6eefd1a88ca104\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"dac909e223539e6d\",\"/knowledge-medium/src/services/authStorage.js\":\"763cd82ae305a7bb\",\"/knowledge-medium/src/services/powersync.js\":\"4e4438b1319977a7\",\"/knowledge-medium/src/services/supabase.js\":\"a9a15b1125f16edb\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"0299ab3ad6ea99ed\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"b01a1e5ac1a83e0a\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"04cbd96acfa6a9e0\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"04f920923aa53e45\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"79589d217c6d6235\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"1d9d8085640ab983\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"8db56d8c9d7d5469\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"01e1a1e213a22595\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"61e61918fd38c119\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"aed8f81e2b3374f3\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"545664f4daf776f8\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"46e413b833853c20\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"120dec286c90547e\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"b80cf1f8f033f480\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"6f017bd55d69669d\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"3da496b76298961b\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"1dae459428c6112b\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"cbc772f6cb79e96c\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"0967499fbfd92e0b\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"a5809e17326d718e\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"072b45be72876924\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"66f98d54b6256cae\",\"/knowledge-medium/src/shortcuts/types.js\":\"ad16bfe87877025c\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"8f92992085c361d1\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"24e5fa15d06f146a\",\"/knowledge-medium/src/shortcuts/utils.js\":\"95592450ecc8831e\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"cf2e046264987c56\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"31b7ddac969dff9c\",\"/knowledge-medium/src/sync/byteTransform.js\":\"92d046d59953c7fb\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"7611168159478213\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"a186cb01a6f52bfb\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"76111981db0b6546\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"e5ef44ed19d285b0\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"370bb0596c688ac9\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"907dd2878912275b\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"f6e58b6eced35a59\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"5491aa3235c7d797\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"b1082c1e9e07a980\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"80764b359703a91b\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"5f6dc513577449d9\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"e93696dc8fc75f85\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"750032a7340c24b2\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"d0d9ab900342bfc6\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"03662f7e60dc0af8\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"0542ad706cdb97f4\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"7255edc86c47be5a\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"313e595a10125d66\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"5d5c9c4330e23a05\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"490d0d647e76a2af\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"adab88a879c73806\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"30d7ef090e5f909c\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"a60dced10190998b\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"ef713a2c8c2b7372\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"b7841a85cd5cae41\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"63f5b0ce3c21aaa1\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"66c3b870334e54ee\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"0e61486a71c5cb1a\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"43831d455f0f39bf\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"4e29ca3795e544f4\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"f06d33f1598bc526\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"2d28d12c60814f6c\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"3c8c6a2a28ed6d25\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"674684429f0c04ad\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"6546fb3af8252008\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"c157316219eb6ec3\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d812dc34bb22a41e\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"e938883e4ee529c1\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"decc4e836f9f92e5\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8416f8c440401af2\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"ff6cac56bbe94a2a\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"1050e3d6ea559c61\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"ecbf5093ac26d7ad\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"ca578d1c0f31bf8f\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"62688212b26ec43e\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"94aaa8cd4fc54b47\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"19394cf834fd72c0\",\"/knowledge-medium/src/sync/transform.js\":\"f4609e3b3a2b1332\",\"/knowledge-medium/src/themeBootDefaults.js\":\"8d0be473789abc6a\",\"/knowledge-medium/src/types.js\":\"0254003bdbe95564\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"8a4292187134274a\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"f424a67c2e6d5367\",\"/knowledge-medium/src/utils/array.js\":\"9ec3835e0b36cab6\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"b3d49cd7997fcc99\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"9f09cc4ef5aad7c9\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"8688a338dd58642d\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"c9ef42b1ef083c83\",\"/knowledge-medium/src/utils/callbackSet.js\":\"0481e1067a7aad82\",\"/knowledge-medium/src/utils/clientId.js\":\"e0097389658f76e7\",\"/knowledge-medium/src/utils/codemirror.js\":\"2e9ec10f31698e98\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"e07324b18befa36f\",\"/knowledge-medium/src/utils/copy.js\":\"0266fc335289c075\",\"/knowledge-medium/src/utils/dailyPage.js\":\"58e147de6880f1e6\",\"/knowledge-medium/src/utils/dbForensics.js\":\"0d936efbddac716d\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"37f2ebb628214c68\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"3ee76f90f4e35dc2\",\"/knowledge-medium/src/utils/dialogs.js\":\"afea77ced8a14b39\",\"/knowledge-medium/src/utils/dom.js\":\"9a22dc17248b16f5\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"014ce509e72ee3d1\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"dc86cb94a7733bec\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"9dc3c13ac817a5a5\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"1de2102b593abfd3\",\"/knowledge-medium/src/utils/flipSlide.js\":\"127eb5ff7cbf5c28\",\"/knowledge-medium/src/utils/fnv1a.js\":\"8f4780bde470baf0\",\"/knowledge-medium/src/utils/formatBytes.js\":\"3de8c5f1c822eb13\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"877069bd5beb5230\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"c6677e5e400cb7db\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"9beddf440ff967e5\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"774f85c6a36e8782\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"e9155657049f5ac3\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"3c698b0941bf45eb\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"15f7d2ce8827e585\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"4977ee639a3c2b8d\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"2ec3dc88eae214fe\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"c6f1bceb577dc613\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"2112d60e3e7645bb\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"07f976980f975b2c\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"999335209d22f266\",\"/knowledge-medium/src/utils/markdownParser.js\":\"8e93108708e54604\",\"/knowledge-medium/src/utils/memoize.js\":\"3da57b3f089f39be\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"fb9e7bcfda004c05\",\"/knowledge-medium/src/utils/nameList.js\":\"5bdd9949ac75270e\",\"/knowledge-medium/src/utils/navigation.js\":\"fe6b10619bd10843\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"af7fc4d1c7bab3b5\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"c72fa61f52c66982\",\"/knowledge-medium/src/utils/panelClearance.js\":\"6ca090fdaa3c6f14\",\"/knowledge-medium/src/utils/panelHistory.js\":\"dcece8b5a7846f44\",\"/knowledge-medium/src/utils/panelLanes.js\":\"91abb42eb7b9188e\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"1e9d39d1c40f9bea\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"a70c2a9b6e6ee043\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"a3fb83eae1f767f8\",\"/knowledge-medium/src/utils/platform.js\":\"b00319033aa76830\",\"/knowledge-medium/src/utils/pluralize.js\":\"787ec39468eda200\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"5ac9934cfe9a3558\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"17a4a49f73b58927\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"e22ec67c7a3a0781\",\"/knowledge-medium/src/utils/react.js\":\"a0a21e3295c1ab74\",\"/knowledge-medium/src/utils/relativeDate.js\":\"14d1ecf2ecb1b0d3\",\"/knowledge-medium/src/utils/relativeTime.js\":\"349c19543b31a84d\",\"/knowledge-medium/src/utils/renderScope.js\":\"2b5e00c55b08ca0f\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"76acf9221d9d28eb\",\"/knowledge-medium/src/utils/routing.js\":\"5aaad3a36dac0498\",\"/knowledge-medium/src/utils/safeMode.js\":\"b79abd6f7b682c23\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"7ef76dcef9aa5c64\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"410f915fb0df469e\",\"/knowledge-medium/src/utils/selection.js\":\"d8b7fab8ae84b8ee\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"9de21d798858700e\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"02e63b16e364545d\",\"/knowledge-medium/src/utils/state.js\":\"e79954691833eeb2\",\"/knowledge-medium/src/utils/string.js\":\"c5ca0747e23200cd\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"7596cd8783dc3856\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"a604be220992f6ae\",\"/knowledge-medium/src/utils/toast.js\":\"ad4423d6735fe3e1\",\"/knowledge-medium/src/utils/toggleStore.js\":\"2b07432fc41ecbcb\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"bd034bf5883ff52e\",\"/knowledge-medium/src/utils/userActivity.js\":\"b43e6d20a3bbc85a\",\"/knowledge-medium/src/utils/viewTransition.js\":\"6eadf2e162d1e337\",\"/knowledge-medium/src/utils/viewport.js\":\"de939970119b8353\",\"/knowledge-medium/src/utils/webLock.js\":\"5ff62628b9471a6b\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"710c349794dcfe4f\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"36f744c4ea789aed\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"a3806de78c39eb37\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"5457a3fe452c5c09\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"8e4cca7950beb1b6\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"e25d95c043643f50\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"d7f8f036ec1101fe\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"c2598152023cb7a9\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"2227628be3e5287c\",\"/knowledge-medium/src/vendor/react-dom.js\":\"32efbb2b671a4165\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"32e1191849479991\",\"/knowledge-medium/src/vendor/react.js\":\"19882f1efdda7d08\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
