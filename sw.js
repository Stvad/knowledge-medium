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
		buildId: "cb4b83dca5f7-3e3f346e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"a887d839ba68ac89\",\"/knowledge-medium/index.html\":\"a887d839ba68ac89\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CzzPTp_C.js\":\"3166a19a6d8b9a8d\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"50eeb3c1514089e0\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-C3c3GR-B.js\":\"a20ac8654a1bc36c\",\"/knowledge-medium/chunks/FacadeVFS-BzPtnRmH.js\":\"7d5bda39b62268ca\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-CnPzHC-r.js\":\"7c4f23a7dd71990a\",\"/knowledge-medium/chunks/MemoryVFS-D-Oj6rVp.js\":\"95f490d01bccd9bb\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DDOXot3I.js\":\"b36e0a9a6e88526f\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-a_1zArFq.js\":\"222946f8eab98271\",\"/knowledge-medium/chunks/Preview-EAwOC3xU.js\":\"6b418ce143f5801f\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BAzeUi-J.js\":\"b4111feb67b9aa34\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-Bj8DW_sy.js\":\"f1e380e7bc561506\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/freezeExtensionImports-Co76Yca8.js\":\"21b7834d81889566\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B65KFw7a.js\":\"db398b9b5f88091f\",\"/knowledge-medium/chunks/react-BhWrvTmB.js\":\"f027a0f419fd574d\",\"/knowledge-medium/chunks/react-CT_iBuO7.js\":\"321d5a5b289a0f43\",\"/knowledge-medium/chunks/react-ChAZKq-Y.js\":\"25aa089e7bf42ceb\",\"/knowledge-medium/chunks/react-DmYbZkdk.js\":\"2a473a0655879b94\",\"/knowledge-medium/chunks/react-PBNeOWjk.js\":\"537688303e3cc335\",\"/knowledge-medium/chunks/react-WILaEnJh.js\":\"d225e9610de3daab\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-W4FiGkUu.js\":\"2739d293f85aa6dd\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DlLhgGr9.js\":\"a5db5ab37075b3bf\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BgXlrP0D.js\":\"dbc7b25ccdfcb50d\",\"/knowledge-medium/chunks/react-w3wE1GOm.js\":\"986714d72734e9e2\",\"/knowledge-medium/chunks/server.browser-BYrkjUnv.js\":\"c898b8d74594d5ba\",\"/knowledge-medium/chunks/textarea-Dndoipq2.js\":\"8a1e73786ba4c940\",\"/knowledge-medium/chunks/ui-BSG96ZgJ.js\":\"19814003cd717f7c\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"a73f5b254184a1f5\",\"/knowledge-medium/src/appUpdate.js\":\"3d3e72b9d1d67b6c\",\"/knowledge-medium/src/appVersion.js\":\"bb69cfd6617acafe\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"b594767c58f40b60\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"8963fb11fd394893\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"bddd5cada85a374d\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"29fb49c5bcd6aaa0\",\"/knowledge-medium/src/components/BlockComponent.js\":\"db406472f9f50fee\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"d85a58353f3da27e\",\"/knowledge-medium/src/components/BlockEditor.js\":\"8396d4f18e312ece\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"9546009a26cedcbd\",\"/knowledge-medium/src/components/BlockProperties.js\":\"71688b216d215b59\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"d38dd810e5807e88\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"dc27e1d07ec1a586\",\"/knowledge-medium/src/components/DividerHandle.js\":\"f90e4e2a35a08945\",\"/knowledge-medium/src/components/DraftEditor.js\":\"79145514a131bedb\",\"/knowledge-medium/src/components/GutterPill.js\":\"ff92a2759d076108\",\"/knowledge-medium/src/components/Header.js\":\"6960d65c3cb3ac0c\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"32bf686abf758a83\",\"/knowledge-medium/src/components/Login.js\":\"05912f70220a6ba6\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"295f6b698d460a48\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"d0f0ef1c7835af79\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"79543d25a8b26519\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5f512f3426950e49\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"1531bc9ea2fe1d3e\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"f224fb0eb9985014\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"11267a9a498c8b79\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"f318c408629121ba\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"74d2e568f9be2d0d\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"52cf0ae55457517e\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"f6c181a01a8a6288\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"42f6c1382755609e\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"b612651a953b8ba6\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"8097ca21e5b4d43a\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"23567fa378450a44\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"a72a63df22fe1dd5\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"1847a3416a20d759\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"efdacd76d4fed729\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"70635b3112b5bd49\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"3e49ea597ca4f790\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"b676555a45365cc7\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"5317ad057434c69e\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4bcc91771adf6855\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"6caf6263b4023873\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"e061f60234f7fc10\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"45f09c484d97103b\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"838735d974b0f51a\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"9d1cb0c98ee832e2\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"f33052bbbf749d8b\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"dba2a0ccd5d0579f\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"321216ba6ee6eecd\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"cd8b9d8b1535068e\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"8801114653c701bc\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"7296f4b785294529\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"3e8f92c9689f1164\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"aece5611c2faf375\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"9ec0d9cc03beb559\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"2820ebfaba97660d\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"5a565d5e9d268dff\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"b93f445fb93f224b\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"afe6b41f8c57432d\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ddeb4c37d40dea2d\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"cc1cd7671967fae6\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"04a8f81fbce6a075\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"f36e3f5484f8bc99\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"131fbb7287b448df\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"4537cb2c5ed32390\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"c7a63ebe36986b52\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"6043a60e8af8a3d2\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f6a3b454356aa57b\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"a6cd7aa23cbb63e7\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"ddd9fee4ac1e0b99\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"9cc8f025f09833ba\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"5b77b65a1bcf7005\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"5ba6e08f59433f57\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"7d78b1657854d2d3\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"2dfae4d7e89b1c88\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"c5fec711ba30ba2d\",\"/knowledge-medium/src/components/ui/button.js\":\"750a427ddbc2f702\",\"/knowledge-medium/src/components/ui/card.js\":\"75d6e7a722a137ef\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"917d0316ffc9f27b\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"ac40f1646669f893\",\"/knowledge-medium/src/components/ui/command.js\":\"4f950a2805f9cf48\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"bf255606f1fd6f28\",\"/knowledge-medium/src/components/ui/dialog.js\":\"c3462e48055d953c\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"82f767b152ce0ae4\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"a8dfe6b4a9103ed7\",\"/knowledge-medium/src/components/ui/index.js\":\"d4a2ac39bb5ce454\",\"/knowledge-medium/src/components/ui/input.js\":\"38bfd02b715b1fe0\",\"/knowledge-medium/src/components/ui/kbd.js\":\"e1820bd01f97201e\",\"/knowledge-medium/src/components/ui/label.js\":\"550f51248358b4eb\",\"/knowledge-medium/src/components/ui/textarea.js\":\"bc396b58e63d89da\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"b437a743ccd3ba6c\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"16a7fb65bd00bf60\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"5f51b3075fc58726\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"c9f452f7c73757f6\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"a70504811ab66f62\",\"/knowledge-medium/src/components/util/error.js\":\"1e59e8132b2cf831\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"022fa9f689b0a298\",\"/knowledge-medium/src/components/util/suspense.js\":\"657e47c067a20c6e\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"e9efe964e2341299\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"5b600853148a9ba1\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"c2c36334481b31c1\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"f422c7fa5ae1f924\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"267998f77937267e\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"be11c7a9bfdf41f3\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"b5a72999742d79b0\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"8696f9eb35db87d1\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"b93452d70cc845dc\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"9a79cf059be59998\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"3c9cafac5e03758b\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"50cc214705ac2971\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"db8bf0337a2bdc58\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"daa0cf210c57ec39\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"0e441ef45f1c9ef3\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"871ebce68ba64fe3\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"f59871a7aa4ad493\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"71fe5ac57fc2ef55\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"ee0bf4f5d961088c\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"e441f14f1d2a00df\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"40bada48475a8d75\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"4e7c973f75a0f14f\",\"/knowledge-medium/src/context/block.js\":\"d69ec11bcf9529b7\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"f47aeb575d08f18e\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"bfc728f4bd75e493\",\"/knowledge-medium/src/context/repo.js\":\"8958dd4b06dc05b6\",\"/knowledge-medium/src/data/aliasClaim.js\":\"ce4d1eaa64dcb130\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"25917a5642907d9f\",\"/knowledge-medium/src/data/api/blockData.js\":\"a793eec142aa03c1\",\"/knowledge-medium/src/data/api/blockType.js\":\"20d810ec5683b0fa\",\"/knowledge-medium/src/data/api/changeScope.js\":\"30630782a2026940\",\"/knowledge-medium/src/data/api/codecs.js\":\"4aa71cdc5ff98d2a\",\"/knowledge-medium/src/data/api/derivedData.js\":\"025c03d1b0701ef1\",\"/knowledge-medium/src/data/api/errors.js\":\"f3e9feb6e25ddd51\",\"/knowledge-medium/src/data/api/events.js\":\"d699d0d7ceeca58a\",\"/knowledge-medium/src/data/api/handle.js\":\"06cd87e72770e15f\",\"/knowledge-medium/src/data/api/index.js\":\"5a0ae38cda5b1535\",\"/knowledge-medium/src/data/api/mutator.js\":\"239b7762c500b5f5\",\"/knowledge-medium/src/data/api/processor.js\":\"0a3edb439829d01e\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"9573b8a0d9f68ed9\",\"/knowledge-medium/src/data/api/query.js\":\"acddeaa248b36570\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"f17938c3aa77d3d8\",\"/knowledge-medium/src/data/api/schema.js\":\"06cd87e72770e15f\",\"/knowledge-medium/src/data/api/tx.js\":\"06cd87e72770e15f\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"86f99723224e74d9\",\"/knowledge-medium/src/data/api/user.js\":\"3449280b827eed9b\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"335d90f056571348\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"c976325c6027de08\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"1e77a35a723fd48f\",\"/knowledge-medium/src/data/block.js\":\"9316f9cc4ce285da\",\"/knowledge-medium/src/data/blockCache.js\":\"4ecac24e21380ad0\",\"/knowledge-medium/src/data/blockId.js\":\"813408c5c4459b14\",\"/knowledge-medium/src/data/blockLiveness.js\":\"749a902849904b8e\",\"/knowledge-medium/src/data/blockMerge.js\":\"1532ccd00943c306\",\"/knowledge-medium/src/data/blockSchema.js\":\"ecd2906320ae3c60\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"24c8dfa9f7e19ef6\",\"/knowledge-medium/src/data/blockTypes.js\":\"2d827ee2e0eb1b93\",\"/knowledge-medium/src/data/childrenView.js\":\"8f2978cd0b4871d1\",\"/knowledge-medium/src/data/clientContext.js\":\"e5b44334ca0bda8d\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"4956909f886849a6\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"9d8eac47031a55e5\",\"/knowledge-medium/src/data/derivedIds.js\":\"4f5b2e237bc33ef3\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"87c8e1fd963741be\",\"/knowledge-medium/src/data/facetBridge.js\":\"0385f96bd0ff5eae\",\"/knowledge-medium/src/data/facets.js\":\"64b863b6deb6fd68\",\"/knowledge-medium/src/data/globalState.js\":\"20ebd3f2477c69cf\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"3f41e221d6eefdb7\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"13ebe42297985f7c\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"c6932bfd5c52eafe\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"113529d225de572d\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"8234b6aebc4b6ffd\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"362171007c126bf1\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"6ad64974c7227c6d\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"506fd4e0333eccd6\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"55b2f07955c82d0b\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"09d2d6336ee160cd\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"e69cde78cd8bf290\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"b0e561def9477aab\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"1b05460334802112\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"92aa32bc8243a78d\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"7c88bddda5ec7e38\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"e3494b83e8965e38\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"78906f8dcf5a6bbd\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"69624ce72f707e49\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"c8d51cb4dc6e6580\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"acb420d7bc4555a1\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"6a0f1ec3878237cf\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"10dc6598f4ebb74b\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"6a11266824209b46\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"a3f1405c836cefbf\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"7b8dff4cae12f443\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"3cee12c810923d3c\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"7090976028ff989f\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"a2a888e903216bce\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"3e25e310e1ac0606\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"ccf8b999ff25efaf\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"f6910651b72eef02\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"2504ad747898d2a2\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"d28d0bb01a945e6f\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"b886d7e127603d73\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"c279ca9a92bff7a6\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"60300f31623e4fac\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"08600971ae981ff4\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"9154c9352bfc5358\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"03990885124fac59\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"f8b9eb4018e133ae\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"112a23ace7250ced\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"0a88a9d0e518b80c\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"05eed91c29f6e757\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"5bf8e89a068ea860\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"0d1bb38c5e2bcf3b\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"8e3ae4ddb54df7b7\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"abd27a373da47f26\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"6f89feee52f778e8\",\"/knowledge-medium/src/data/invalidation.js\":\"2ed8ae317bb96284\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"6ffce50ea583d84f\",\"/knowledge-medium/src/data/kernelPage.js\":\"c4c54a403d4bc119\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"f81fead492d5cab7\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"b1b83b5fc33af347\",\"/knowledge-medium/src/data/localDbStorage.js\":\"62d48348c972f502\",\"/knowledge-medium/src/data/localDbVfs.js\":\"d4e98418fa0d8606\",\"/knowledge-medium/src/data/localSchema.js\":\"6aa256cb66eb3786\",\"/knowledge-medium/src/data/maintenance.js\":\"45d93eb00aa4fa74\",\"/knowledge-medium/src/data/mergeProperties.js\":\"5759f24e3f954555\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"82f40a3aa338fa24\",\"/knowledge-medium/src/data/migrationsPage.js\":\"d793e6f224be0e72\",\"/knowledge-medium/src/data/mutators.js\":\"ebe5c558b37c2763\",\"/knowledge-medium/src/data/orderKey.js\":\"3c5ec50d2d702199\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"4cf66935ec2ef923\",\"/knowledge-medium/src/data/outlineSurface.js\":\"821cd14ee20e90d4\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"c9936acd0e07ea6d\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"627989e6e6f2aa44\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"826e56812a84cd92\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"ea683a40d781f48b\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"cc31e2ed54ff7e55\",\"/knowledge-medium/src/data/properties.js\":\"b6dc5da72a1a31ea\",\"/knowledge-medium/src/data/propertiesPage.js\":\"211d4192f325789c\",\"/knowledge-medium/src/data/propertyChildren.js\":\"44a215513dd8bb6e\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"a1a50a673f356be6\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"d172811638cd8dfe\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"2d3f53fab02071b8\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"b5d72a2120abdab9\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"4ffb560e0bc965f8\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"888003b001315c5e\",\"/knowledge-medium/src/data/propertySeeds.js\":\"2dd0fd12fe366996\",\"/knowledge-medium/src/data/recentsPage.js\":\"aa83e2d75efa3933\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"1e4796656fb4b9ee\",\"/knowledge-medium/src/data/referenceBlock.js\":\"cb735f74b540346c\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"189ee16ccae04d20\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"47c12c3855be3d2c\",\"/knowledge-medium/src/data/repo.js\":\"417d65e4928745b8\",\"/knowledge-medium/src/data/repoProvider.js\":\"991e14730b50eff9\",\"/knowledge-medium/src/data/rowProperty.js\":\"3b284634aac5169b\",\"/knowledge-medium/src/data/searchFilter.js\":\"53dcf39c117f18d5\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"c30725878862e4a3\",\"/knowledge-medium/src/data/stateBlocks.js\":\"fc3dc046098ce180\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"6f29bfdaa4fc77dc\",\"/knowledge-medium/src/data/structuralInsert.js\":\"5ab1d95137c8c58b\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"f174cc9f76c609a1\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"6d4841d259ec761e\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"94be6c3c6fabad24\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"34abb9e3041223f7\",\"/knowledge-medium/src/data/targets.js\":\"4524edfdaeae6730\",\"/knowledge-medium/src/data/typeColors.js\":\"caf3ac6f8ec31ff9\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"7482c898a3debfce\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"c1eb5cc07fd7e44e\",\"/knowledge-medium/src/data/typeExtraction.js\":\"38ffe9f120f02f5a\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"dbc33c55826edd2c\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"63141ed4c8086d5c\",\"/knowledge-medium/src/data/typeSeeds.js\":\"2f00b65a4927b976\",\"/knowledge-medium/src/data/typeTagger.js\":\"eefa63cfcd277bd2\",\"/knowledge-medium/src/data/typedRecords.js\":\"59a630abc0906b14\",\"/knowledge-medium/src/data/typesPage.js\":\"251aa1be7299568c\",\"/knowledge-medium/src/data/userPrefs.js\":\"c52aaa65a4440021\",\"/knowledge-medium/src/data/userSchemasService.js\":\"7a7e24b4400bdc6c\",\"/knowledge-medium/src/data/userTypesService.js\":\"7fdadb67eae670e4\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"93e9d1ea11f86480\",\"/knowledge-medium/src/data/visibleChildren.js\":\"44e80ff8a5cbb352\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"02cef0e813140324\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"8c18efc9520becf9\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"d83dfffb25a19836\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"a327058416e76f3d\",\"/knowledge-medium/src/data/workspaces.js\":\"9810675b6c746f37\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"9e8028d192f39a50\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"10e40f773ce2ece3\",\"/knowledge-medium/src/editor/atTrigger.js\":\"1df39b249d4f3aa6\",\"/knowledge-medium/src/editor/autocomplete.js\":\"2dcbc8a5509574ff\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"23a617b82a97d928\",\"/knowledge-medium/src/editor/contentFlush.js\":\"6d934b148b66f6b4\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"553ff1daf0b167a4\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"2c25b65c1a8f26a0\",\"/knowledge-medium/src/editor/insertImage.js\":\"86aec4526b833979\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"da44e35d3b61df5f\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"25a3a4643caceed4\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"ad4612f998e115db\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"073429e240ad80c0\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"082f1ac853ceb4b0\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"659b4263ded1dd82\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"0c0965d3086b0ea1\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"1c3e4c2fe5bc4db1\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"924aa87500a43e17\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"68e86251628531ea\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"2d02055db266fda8\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"2038fe1a9e5e957c\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"9bb0fac016db5db9\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"a41aafef969e2e76\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"0f29ed0d941959ce\",\"/knowledge-medium/src/extensions/buildApprovalRecord.js\":\"10343f0d9cfac92d\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"e55d4122aef87d29\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"ea00ead05936c34b\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"ded267587fcaa5c1\",\"/knowledge-medium/src/extensions/core.js\":\"bc079ecf01a74324\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"bd1cfce3fd9e048c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"71cd902169309016\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"8d812b9e822ff057\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"5ff4c4fb300b8916\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"475316008598276b\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"d7f58fee08f85a38\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"07e8a6dc8f2c87cd\",\"/knowledge-medium/src/extensions/extensionImportPolicy.js\":\"8b9f7d8bed9a7046\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"272b25e8d0c00294\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"4a31c301ec0287c5\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"28f72fcd3dd4932c\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"c3959cfc6dd746fc\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"1fc0c942aa67e411\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"48d03610182bff58\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"33d5984c2ba466cf\",\"/knowledge-medium/src/extensions/normalizeExtensionSource.js\":\"aa979d71badabca5\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"e6520e20983dd2af\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"c53862fb513baf14\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"b08bcd6c04b93295\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"d9ac4bc42691fda8\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"a1ee223e886c6fc8\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"8754cf7d58404667\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"7a4d572316741da8\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"1b009b4c1da2b7be\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"6668eec77455bb44\",\"/knowledge-medium/src/extensions/transpileExtension.js\":\"db52e17ee5ede2e1\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"6d43476875bc450f\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"b8bdd0a8e3045350\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"af2219601f269908\",\"/knowledge-medium/src/facets/facet.js\":\"d496e4d5b6979430\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"7804dac643a222a9\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"96c7d6cc98bcf3b9\",\"/knowledge-medium/src/facets/togglable.js\":\"fd2d142f39ade07d\",\"/knowledge-medium/src/facets/variantFacet.js\":\"9681a565f32a0982\",\"/knowledge-medium/src/facets/verbFacet.js\":\"074f404f3afd331a\",\"/knowledge-medium/src/hooks/block.js\":\"1b3dd58b89643817\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"af4f59843c0cb21c\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"35e26258c6354046\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"068a724a4479a8b7\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"67fe57c7843ab8f2\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"a95827fd94ac0310\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"e745eeae85548f07\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"def9027dec84573b\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"1833d23369f87251\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"66a9a6d0b04a0336\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"8a3193a62f0ec59d\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"c739cc66ce532141\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"589a918e5069b39c\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"b9a9cce4d045ac5d\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"c55a4a6c06b4ff45\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"e2741fe92aa4d601\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"1dcdcd47618fc3cf\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"4d73003653f8be0c\",\"/knowledge-medium/src/lib/utils.js\":\"f718ef292fe90e62\",\"/knowledge-medium/src/main.js\":\"2bef333bfc2a54ca\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"178509e71b94cbc3\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"e134eeb7d662378a\",\"/knowledge-medium/src/markdown/context.js\":\"a25fab3b9fde7e9c\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"c43e1c7b2c3fae8f\",\"/knowledge-medium/src/markdown/extensions.js\":\"56ed94aef22c261a\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"7fac5c6175dd2413\",\"/knowledge-medium/src/minimal-editor.js\":\"f9185532b887ab26\",\"/knowledge-medium/src/paste/armedCut.js\":\"5bf0e8cf722acd42\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"04bd59c9f375d8a2\",\"/knowledge-medium/src/paste/clipboard.js\":\"673e75bfc65a821e\",\"/knowledge-medium/src/paste/decision.js\":\"1c20dc69c11e5de0\",\"/knowledge-medium/src/paste/operations.js\":\"994e15a70465444b\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"70647443efb80881\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"8aece0ead65daa5c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"163a76142feb1e11\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"34924343d3d94868\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"817c72b7d8428b82\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1fdde3d01252f27c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"fb9183098a982082\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"664f17f07fc96d55\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"7fa1de122727508a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"94526b01c4cd1f17\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"eca72d742a4e17c4\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6e7b15eec90b1fcd\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"551022f5ea881eaa\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"1c93cf73bac84319\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"dc81404d36e0e652\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"387824a18af17b41\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"b5f44edddd4fef1c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b7bb74658a1bf0c4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"8ac00d4cdd7cd540\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"1b0445fee9010a13\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"4b6ba2a1efb8cc83\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"99f20432500347ac\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"9499d918313f650d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"8b563698117292f7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"5c5f60e9cd0563c1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"b17f7c6ecf652b4c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"59eebe5df70e2a49\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"cecf86500eca0916\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"44a7a88868aef0ae\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"2265288e272db001\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"782923288d0dc952\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"4170503c16fcc95f\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"580a580a0716ff01\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"5f5b1f24401f47b7\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"e3d3bb376af4ac2d\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"aa951aec0e575999\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"c5cfd0aec7ee8066\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"ace1e22eacfa558e\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"8775c45c6ce499a7\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"fdf5baa8390965c4\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"3816ae28326882d8\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"9cad368600fca5c7\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"48194a39f94cb16e\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"1ad72bc4921aa67a\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5a5989af973f8734\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"c39a677481cf6994\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"9e3746555eafd48a\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"43bf9d29d71b834e\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"ffa58095d6fac290\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"e57b7af0d153ef6e\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"b3c3c2fde210046b\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"89eaf5d5e3578405\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"3cedd838f3ad84db\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"1ffb285e164fe90e\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"12e468deac800185\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"4250492966b12ed6\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"b0fe163faf709919\",\"/knowledge-medium/src/plugins/alias/index.js\":\"0361b183c7702600\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"91f63ae49c734f34\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"969bc9cf37385a05\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"31448f33636290de\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"1384d309fe1be268\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"d4d977e9f4b4b376\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"47533f00bd3fe44a\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"c923a3f0708e9089\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"b7caacc963c57ab1\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"21ea235bf54bb579\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"594c7f24efbcb48a\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"a847b22f48dcb79e\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"f6ecdbb5352a992b\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"4706a48526aadc6d\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"b2de99bc33e2effc\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"d325c6af26bf8e6f\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"46a7b8035b2fbb30\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"b0293cda0db0dd36\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"fa4dc2a77eaa1a2a\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"b31155c0c57ba56a\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"a130c0686029e3c7\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"dee0a0e4d5df969a\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"5d1153716f569dd6\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"4bdd54ffb4fc57d7\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"9c27ce335f086363\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"bdeb6925ed9817fe\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"71460646c7eeea70\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"bb2062de9e306d85\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"2c60c3b15cb06923\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"da9d90b0d269d4c6\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"7f43bdfb7da2ce00\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"e3bb2efaf204c429\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"466aa347e0fa18fb\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"af1a73d0241d968b\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"7cca80217a859af1\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"008c473788a6623d\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"77b841d547ff5c84\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"d8ef1995df71b449\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"c8840c32fe634fc1\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"d257fbcd3341b81f\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"a4fa42c4bb45ce41\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"fa0618f294de3040\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"662631387bcf36bc\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"a2347842075b5c1c\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"70a0881d7d98bfad\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"4270c82e501d1dbf\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"6bf12dcb3b475eec\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"43c0acd4a971f322\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"719687c0b6d51bd5\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"081d21d625ea75e0\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"448c9f42c89d2800\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1a183da49e6927b6\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"1031c2806edb9cec\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"161262b4bca18d2d\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"ee07cc557a0acfdf\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"0565ebaf8d503620\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"9547422fa3425274\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"48f2da2e0187c70f\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"3ab6ce3f668b1e56\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"b6672c6546e5116c\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"baa34cadcc61f2d5\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"c502abf8fb70a3be\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"049a91260347a851\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"906b6b091ca15332\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"3752025d7068c87e\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"0885f1f0e104b5f3\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"48c9630311067d72\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"2271dcba48d7e648\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"85de67eea41caa45\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"469aad0e34391b48\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"4b886af475436a65\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"3006d3a6530f1c09\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"3ecfaabab71aeae1\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"789a8f7dc36c8bda\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"f3b4ca3cb043b59c\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"7f0b648013c5dda2\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"ba2bf818a5e38290\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"cc9739d1a1bb889d\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"18de01ba7a0f40eb\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"8d8ccc1e8d606fd5\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"84672c39db51f857\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"9f5f3120354456b8\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"dd81381ef75c70a2\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"362909c498890e76\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"06ac0af7233a2b13\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5e4230115965197b\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"0ba170cc727120b4\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"fbca7b3a64edc9c3\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"a5034a0ad7c8eea3\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"3979fa9de9ff1a29\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a6138bfd4253194d\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"c52eeaf4afb015fa\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"75f0eeaa4930f295\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8989c836289726cc\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"60fd7cc2a3e7357a\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"d18d05debc574d00\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"abc11e8eb557754a\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"812c70003268124f\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"fbc5d7ceadf93ee8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1f8e57e30ce49244\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"aab1b2bcd67a6395\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"3c576bee1e5154c8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"35f6a6095ce533ce\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"23f3731a54a4e431\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"90e1ab5011e90c58\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"1375f87c8e64ea7f\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"5e6aca73b1aa8db2\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"db1b1a3a0aea0bc7\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"a338fa3df6586ec3\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"48ecad37d7bbfcd3\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"3e4304c7f5cb3fa8\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"6f34f67af4ed83d7\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"cec614900a18622e\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e4c04389637f844d\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"531941be3c7bff06\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"3e45a0a359ad0da6\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"c762683f47ce89fe\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"3e0f94220f049cc8\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"df701a16bedc9216\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"a5998030febcafd3\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"771952c65ac447b8\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"f8fef182d7c50a61\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"b3cc3b3d215d8e1d\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"47fa0591883eaf9b\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"e25c662658a6f267\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"0eaff2add99117e8\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"5193a8b056fdaed9\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4670f1ffd01fa376\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"d8174541c75d7503\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"77568723981d1155\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"1dea4445d2419971\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"d8eff53aee3dc490\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"b996df1bebe8df2d\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"8fd34b3742c321d5\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"bd677515d37a68c8\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b7e0a1c415dd7046\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"22d7eab42645eb63\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b4034adb99e2e8c2\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1970ed67c7bcd727\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"94a1568f82d7f08a\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"5459c3fe9d0d70e6\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"33712cf201b02b36\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"731b03b4d292b846\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"4c5939ec2de29c92\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"3d5a2079dca8d810\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"6032fcb6fd43569d\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"be5326c6f5d60dd4\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"1349abe94971a6c9\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"84633fc5777701f1\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"5d74f9758fc5baa2\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"40c7c76eabf27495\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"fc338ec5325ee9e8\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"73d0b5d89542ed92\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"d38f9de942ad1540\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"dc2f5eb546dadb96\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"cbc1e9ac6aa053a9\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"8c285adfe230f604\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"d472a214fbdf82ba\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"56681cb43fc6a863\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"48a3f0ae20230ea8\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"bad6b69d31b31958\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"4fb86df43256ee3f\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"b74d25b8d1bb843d\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"e2996dfbecb20bc8\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"73f6b244f53731dd\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"5a9cd9b6e8c828c2\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"c7dfdbc15d528f1a\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"a6992c59bf1207ee\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"f0c3b1fd99d6dd0b\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"52dd80813e6d3453\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"67811f70831ae0b5\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"4e917a68666c00f4\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"b92495a917de2791\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3954503074987c21\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ae65fa8cca12ff5f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"cb48396c9ce4486a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6f0673075bfafd3d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f8f3083fc265116f\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"904aaca5e6edcd6e\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"0a05b2381d2a6de4\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d3ba1f113f0b357e\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"f40c1e17d2aa6754\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"6d9a7b05c28f0c01\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"f7d2300dad0dc12b\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"6e540310b8adc8f3\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"e5d89a63e717d807\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"26faa9cc83867d4d\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"07f433ed2cf1f8c9\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"be4cd19d540a3edb\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"81325334377e66ee\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"ac2bf9d2d53053e2\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"c3cabfadedc11fce\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"005648be31f72478\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"9c0e6cbc55f73f6b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"d9aa0f88b6688583\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8a97403558baf112\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c5bf9f17e0441e69\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"5ed30a9a4612add5\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"9a54aa99d367828c\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"c543fab8f825dd24\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"c7f73ddb32322e59\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"4be8e3f181018881\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"928249db05b08174\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"0b8fa8578bb9a5d1\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"b1ffd5917db4e8a7\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"eaadd929747eeca6\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"6671e96889c3b51f\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"bbd3cf2c7619e8bd\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"7de7e2cbf986b694\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"9963d98a4c103f94\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a6abed485246d13e\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b1d474f888a4802c\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"e588cac93ba20815\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"23e0f1ec8cf8a7d7\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"8a5ff6af6db55ff3\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"c35ee3adeda3f7b3\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"cbc7e628178ebf3c\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"3bc8d8b25275cfc4\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6e2736fc7a1abf79\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"0a88141554a0c0b1\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"b11653b666ff2754\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"7b1f79fbaa0796c2\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"b6c098dabc90e5f2\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"5e804393031bbd4f\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"f1be9e7df0884007\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"226b404cc1d6979c\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b79d51489f2c19b4\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"94073a46caabf17d\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"8a4a8603a156cdc3\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"0f904008cc415e87\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"49f29590f381ad70\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"b77cc63f8cddbef8\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"05c2e18f64d93abe\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"912470b147cda366\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"ac40b6f80389f118\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"e95147309f59328e\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"3e17e712a91cb078\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"fe7424c1ca277ccb\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"5cb4a70e82bb9ac1\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"877e3b1717cd7adb\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"70853327dab805e3\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"3031c6b21bce1104\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"09555d60edd4f4b2\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"a8c94768c4ca83dd\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"67ba0b16a259c115\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"e7f716631a9bfa97\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"620091acb3fd0727\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ab32920a2db7ddfa\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"3907c6f64ba1391d\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"f06b682e4e9c1abe\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"2295939e4cf8e938\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"a0e52f1783645dcc\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"bb60abc78fdcf06d\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"fd5c5b358d683f20\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"343824f5d650867d\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"af3f35a739e576dd\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"65f5bddc7cdf8c6b\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"d8e3ac772dd175cf\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"ddd5eee256cf5e0c\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"6df1cd866fa26da2\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"d6131ef64e73aa1d\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"a0281a4f1d391036\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"d21e5e94acd7844c\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"e92ad42a56548031\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"4963a5cdcf2e8256\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"df5ea00262aa0c40\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"befcf2869dbc7091\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"8b681d936cfcf5ab\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"f0ca043fdf2eb372\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"6a2d496e192ba628\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"9e69aedafc7de3ba\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"f0549ddb69c4c266\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"5aab9bcfd8c25daf\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"05744873e2cb92d4\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"257cf29d92148042\",\"/knowledge-medium/src/plugins/geo/index.js\":\"92ac09c0914a5e54\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"0dddeb77ddda31ab\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"748527900205b52b\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"de229a55db58a6ad\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"0d2bb550211de909\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"49b87b5cbce8f7c5\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"e0b2daab57d286f7\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"32da65ee997b1c2f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"522fac788cfdb67d\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"962b14429e79e934\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9dad44baccfc8d1f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"675d780babcf2fe2\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"df04fc865bae83bd\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"4066a3eddb04a349\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"909288bf8e07b85f\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"9b221a09d10f5de6\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"a7b7585fdd6feb93\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"c938ac98d9f8964d\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"dd5d060e9a76cd85\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"dfad2dd656372673\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"7fd4d6974ace12ed\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c5ebe919cf7cf3c9\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4a5e132138087fbb\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"4932eb89796084b3\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"4289ae978551198c\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"42a7adad6f604c3e\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"29b19f203399db05\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"a28b2785ca0547ef\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"4d2e2ce148558575\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"81bed16419243aad\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"d214abd010d88b56\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"c9f85db3698d884b\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"0135d3da72ad43bf\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"0ecf29c4f5bf94ae\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"085f2a103c3a99c4\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"e7ae9c998ef31edc\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"492163070a8b0009\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"a04ebc8dc5195203\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"bf1c6bce0592dc07\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"78b01bd0e3a7bb71\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"78e2f1911943e0fe\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"bd8e081f8e17ba05\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5f8b981d6cb8e1b8\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"20d4959aee8755e8\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"1dac80b597c865b1\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"bb0230290ca7b237\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"10e0299fa65177c1\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"37f46d3894e868bf\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"88e2ea42879ce712\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"42c9c1b33b1570f3\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"60c7f6149e07a17a\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8673a7042104aa66\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"e600a87d4652056a\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"4d1d7489329eeff1\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"496942bbef4667f4\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"c1af3d0945b9a5f8\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"78856985f8296c29\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"83dab8f618c7ebf1\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"8bf40f0a781e76f7\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"81a8a8a4588bf539\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"92637c91333aad28\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"d73abb583845fb2c\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"c0e0267361a2e9b1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"1e005392d6dc1919\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ad1a675ec8a1c63a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"12f575f808848df1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"95fae27bc576861e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"1add45c5729d90a2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0e9f8a7f97548197\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2c530688268a7843\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"99b43211dfc916b3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"3139dddabe58c7b7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"b4a2a93f1644600f\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"48f5d8b04923f8f5\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9967e42c47571162\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"4c1b776d1235dace\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"76bc58574102f03d\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"1cad918b57b3f682\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"8b0fb7f0889dd5b0\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"44d674aa04113239\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"44ed3208bc752cdd\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"fa745276d488ac85\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"774b4d09afe7688f\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"449d6b6cdb4d8df6\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"754ff93f1941fe30\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"8e6e44a0b104eb49\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"175eec89b66182e7\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"b8a215bdde03aeff\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"c3eaf1895fe591c8\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3f0837189abe7952\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"4beb78fee92e003c\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"7a684d0f854cc239\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"609ba852b4de8fde\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"1355f2b5d5220cc4\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"5b73d60a7a3ad59d\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"c7829c33ff461454\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"10504958088d20c1\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"979028e0bf590709\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"bfad297f6ee0cb33\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"45af4583c758130b\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"c1b47208fd6c48b0\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"8bdae99cfe0b5d08\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"5c3cd7ba47f1f14a\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5537a7c2e5046817\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"8dc82a73d7fc5f8e\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"98a9916e601dd140\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"8db430df0eb3f3ad\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"5a8a0daef6474b80\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"3bd718f1558c42b4\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"32bbaec85dcfc9e9\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"643d36f232448d5a\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"9d7a3a91f9a152a3\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"6891865d5b3fe13d\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"a8b83204e30e5dda\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"1eca4de74caf6f22\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"e886648b6a35e27c\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"ea41b4d11ca8f1db\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"e5468a08cde91736\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"8d1590ddb165ff41\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"5e355bd2ebfb07dc\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"39a651cacab138c4\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"2acf4bd69d918d1e\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"c2f323571a893b00\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"c19d9c8bbb28aafc\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"88578131a08aa41e\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"879f46ca93784ebe\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"eece6c5de0253861\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"65678a3626c5b0bf\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"8e9241a8ec638659\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1d0ca6d25c369306\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"c5bc4a6ae8492ff7\",\"/knowledge-medium/src/plugins/recents/index.js\":\"2b261f5b34971b41\",\"/knowledge-medium/src/plugins/recents/target.js\":\"294d7e65f3ca598b\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"9afb4a91f5bbc251\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"8e1aa38dfc380664\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"42c7d18ba020034b\",\"/knowledge-medium/src/plugins/references/index.js\":\"e2d5fffeb4ebac66\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7a7c36a3ea9df989\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"7ba849fddf5b3cd8\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"8b4ce52cc04dfbec\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"814f2c7c90c19745\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f7291713f9f64876\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"d1d8489f04dbd410\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"f8f9572f22420368\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5fcf4be76d37e023\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6810a00845e923d4\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"1a37e14381827221\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"71fcac0868c652ee\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"eaf3855e2f4f38bc\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"288ee3e9a7923397\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"3fc10f4d5e954896\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"b07886d0b0121cc9\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"8b90187c0106175a\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"5e2a8bceebf96995\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"c4f6a31335d33fdb\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"7a8fd2d86deb93e5\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"489fba2e43c79fc3\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"fd58aeb329349da5\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ec040ef98b190fe4\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"7d1dad11a96073d0\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"601272bf44796a61\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"8f152612a0ab2171\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"2c508e106b363576\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"ae345cb470a80dc1\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"2d1546cb72f6b8f6\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"c6510fc6bb5bd8e2\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"71a61b774fd63c52\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"7b86fdd8bb294b0c\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"358f960860dccb9b\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"69e05eaece84b78a\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"8382ae61cf7a0b8d\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"06d56cd9dc1e5d8b\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"a0e38f496766d972\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"ffe94ff9ef840738\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"0c601867f0b9ba75\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"b1293f32a003c914\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"e2d83cfbd0eca858\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"a198c6e749af9d65\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"9b2bb65ebbb13ace\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"9f2fa07640ae1857\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"ef4191666d8e39a9\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"b8e1e7947a8f5537\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"df0ee5acbb428324\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"f57cfd0accb51c2f\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"76a3f7f25399be84\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"3224345dcf66b1ba\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"b7a22a6d97e7a604\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"137b7bd5dac6f2b9\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3c1d3c023a976e2a\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"6c642fb67683439c\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"ec0cfd006c8bf791\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f16e1fb1d5fb306e\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"cbf14c5ce0987726\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"69fd026c8f45957f\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"1dd9fc02faccf211\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"9e74c8fb712a9b72\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"084e6dfaeca8a08c\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"8d6821352fc7858c\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"46451c1c35bd72c8\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"47e93c6dade5455e\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"902b33b1d3477a40\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"cfbde0171abf1273\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"d79df97dfe791a95\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"615a7d83813ca406\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2ed7c0639c234d25\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"77cc7e87d6d01169\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"74768d0106603ea5\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ab75a84eddc9bfe4\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"c87668b4b15b8ff4\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"f5488e4322b45345\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"13ce1a5118c40cd3\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"6e69fae1cb6314d9\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"8cef7f0d812addc3\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"398ab1ef4b383eb8\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"c85bd941aebe6bff\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"0914eeb82ac04cd9\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"f1d8722f6b5b8022\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"15d1df92263adea8\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"8e27ad7da79f9851\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"84a050fedfcc29a2\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"f7d049531bad160a\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"6905ea7e8b9aca74\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"8e7db74e2c4cb0cb\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"c41d4c1d2b4572e1\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"52c23affa913a7a6\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"5d6e0bcbe64c6615\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"eb837b312ab65aa9\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"700858277ca2dff0\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"5aad766f89edfc67\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"6387a34c04691166\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"f56e6c09777093df\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"07675324511f2e0c\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"8f7e45173c24af4a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d86ebd28eb8408c6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"6863093907f4793e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"56728cd57150357f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"7305f89a63e78727\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"c3a4a15c07d6175c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"984e0b6119ecbf5c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"bc859271ac387960\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"d38c509243f0120e\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"18729369d075aab9\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"67dbf4a8b82d6c0e\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"6259b5f7db2a5ece\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9ee7226551a9d10d\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"a5f503e20c64a64e\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"05d967da14ba4ebb\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"a523bfbb7196ca37\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"a084756de606d02b\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"c94ff727013f5ef4\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"e3fd68fc55f7a123\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"d4861c3f3da36bb3\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"5d96286203f9e4de\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"100f02b073a63c8a\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"bae09a3b7b10af40\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"9cfd3923f77c41d0\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"936362df49ed3fed\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"f7b932128168f594\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"5cd589aea9e90ad5\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"ffc192c25c8bfff4\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"795baca8c5adc703\",\"/knowledge-medium/src/plugins/tables/index.js\":\"5e034b57113149f2\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"b1e587e0960c61b1\",\"/knowledge-medium/src/plugins/tables/model.js\":\"a13ff00a34633bf9\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"581b1969dac4aa83\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"509907f22e2e6087\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"77f3e01c0dfde398\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"5b0a07d4575b5dd0\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"4a7a6ce2adfb55b8\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"06b123db982339e5\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"66b6d61e6a30ecde\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"c383db5e95104c1a\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"84682c879119e5d4\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"0eec59da7e74b688\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"f1b1303953b805d1\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"d1f64442d80817aa\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"d5a9b7451468976a\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"8f1ff1fef1a8f50a\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"ccf25f410b7f969f\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"e2a3e266f499cb61\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"45f71c0e6aabd91d\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"6f9f29fe72c56c74\",\"/knowledge-medium/src/plugins/todo/index.js\":\"fce79c5636448726\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"f032bb05feaba626\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c9c072550f8ea0b7\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"9f7e0a6e088610c0\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"94f32c26b262948d\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"55ce3b1477ecb58a\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"1361914ec909c894\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"689f1141861d9277\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"53b86e2c833ee8c7\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"9bf6e318b031c03f\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"7e3d8be650b0c174\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"e191b818d2f703ee\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"c3eaac6d8a111c18\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"d532b1cb9e308888\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"ff45402a672bb611\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"17bfdabe4416a178\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"809cbaefbe46fff0\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"a6327055494f27ac\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"e9f015b237900993\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"1e78abafde4bcd87\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"53e15ecc59b8bc0a\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"90b6a13ff17b08ce\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"d6839786956b0e3e\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"59a79b777d358e3d\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"6a1e78596aa159fd\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"88c906981ab7414f\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"190cc1174de08863\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"20d76e320f020183\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"2d58913a3151f000\",\"/knowledge-medium/src/registerServiceWorker.js\":\"06e0ec770717fa6c\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"d809537d847bf7af\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"ca5befb0c405c345\",\"/knowledge-medium/src/services/authStorage.js\":\"eac8e78a1a5ea181\",\"/knowledge-medium/src/services/powersync.js\":\"65001da52c14ffce\",\"/knowledge-medium/src/services/supabase.js\":\"14a531004cb255c7\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"fa7d48539da0d6b4\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"52825fc625aceb56\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"8042ff7e95a8262b\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"b2931f4117cdd578\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"517fdb59e78dbf3d\",\"/knowledge-medium/src/shortcuts/actionKeyHints.js\":\"3ea84106d7843026\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"181ddbaf3840c5bc\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"004aeecf3bd4acad\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"4cbf59b48dc8ed9b\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"c3ca634a2014902c\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"76a3bf6bb84c20e7\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"e4afb0eab416aa15\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"ceb7cce87e6ee1cf\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"e328fe5ddf9e2139\",\"/knowledge-medium/src/shortcuts/formatChord.js\":\"27aff1c51f76eb02\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"376d038ebaa325d8\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"ce87858da9365428\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"2b40a274ddb596f6\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"ba72b7b67cddc1de\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"a9c96aedf7bfc9bb\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"93f1b037b19c437b\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"5205dc8b7af0a1bb\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"aa5fd5835935672b\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"a1503b66016157dd\",\"/knowledge-medium/src/shortcuts/types.js\":\"ab95beabd3216711\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"eab4ff5892000846\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"083330d7e7e52fd8\",\"/knowledge-medium/src/shortcuts/utils.js\":\"2be5a8507ecd64e3\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"432b66babe2012b8\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"00412dc03b851a3e\",\"/knowledge-medium/src/sync/byteTransform.js\":\"ef02b03495d184b3\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"57ffa6ed8e102eac\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"a527517078a13bb6\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"dce0e247b304e1e6\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"682bd4043c9bfbd7\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"b42aed9f805dac16\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"a6bbdbbf6aceecb0\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"1cc0da4828409746\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"11eda3eb671e3a00\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"008e7d588f1e0bc2\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"273d00a8dc19dc22\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"3c859ee720443ad5\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"63cba97fc108992a\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"7d296148a65c49cb\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"ff5cef98833ac956\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"f8131cd1de9b76a8\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"84a06b3465a7f024\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"eba89893761f1af1\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"e85e45bb84fbb87e\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"67b647d6725ebd4f\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"a22840818e2f7991\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"1080e4044934cb6f\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"82d7148cfa02fa12\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"54800fc2d76fab6f\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"d10bc6a7cd54cedd\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"6e92f32cdce64256\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"980458c58e976962\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"a2199c6da989cad0\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"77ff67e48c8338fd\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"61567fdfda54bbe4\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"a3a0a785a42902c0\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"0a794ac87a56a2c7\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"effb48445979d735\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"242719a2003a092b\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"93a479794423f76b\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"8dd5ebc138433a3b\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"7ec00a515d029337\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ad54921366e5474f\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"a5a00ed47af66b72\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6aa9fe1371d2ea12\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"57a2c1cfb55ddeb7\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"11ba46fc5a7e2aa5\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"877c814aaed3fe6c\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"65ec821aeadb5b05\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"7542169a7b4f3ecb\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"85ef43d46291c2c7\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"bb877d717f90c8c8\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"d834ecf7ca3033c2\",\"/knowledge-medium/src/sync/transform.js\":\"77b7685ffdb76956\",\"/knowledge-medium/src/themeBootDefaults.js\":\"df0c4ad8e852d694\",\"/knowledge-medium/src/types.js\":\"a649335638f013aa\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"97709bccca9f7713\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"2b7bc3f9f9a20f07\",\"/knowledge-medium/src/utils/array.js\":\"41149d4c9fbd7b43\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"ab8ec7d2899aa1e4\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"afba350ce31c4ac7\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"ef1076735a5448dd\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"6e5a9bebd69e5dd9\",\"/knowledge-medium/src/utils/callbackSet.js\":\"f216052534ed72fb\",\"/knowledge-medium/src/utils/clientId.js\":\"e0001f61ed5fad0b\",\"/knowledge-medium/src/utils/codemirror.js\":\"0530948013ebcbe9\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"1bea66c3dc70b0db\",\"/knowledge-medium/src/utils/copy.js\":\"75f83251e73dfb02\",\"/knowledge-medium/src/utils/dailyPage.js\":\"b103b949b3b6e14f\",\"/knowledge-medium/src/utils/dbForensics.js\":\"3368a0eb98977463\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"0d1a2469aa01ed65\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"2b05206b5bf8c325\",\"/knowledge-medium/src/utils/dialogs.js\":\"8604a8142057db64\",\"/knowledge-medium/src/utils/dom.js\":\"79f58e76e1677837\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"94735b63bcf96fa1\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"7c378702f48724a9\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"edb9e719c4bd7143\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"67e452764407bb91\",\"/knowledge-medium/src/utils/flipSlide.js\":\"3bb12ad8617cadd9\",\"/knowledge-medium/src/utils/fnv1a.js\":\"ab881f8b3f045648\",\"/knowledge-medium/src/utils/formatBytes.js\":\"69d5bc928119105a\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"38e7f3b18ae29081\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"b0e362b7827f91df\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"9329301266d0a36b\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"faa88cf5374d1117\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"2dceea8c1d229fe7\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"9bee7e23b97a4e31\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"b3ea9d6c8b3c3ea2\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"4e967b1900648afe\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"f563f1c22efe3a5b\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"3df30900d42f35cc\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"43867ef8cfaf22ab\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"7e50ab108b273f85\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"749143f2e5916081\",\"/knowledge-medium/src/utils/markdownParser.js\":\"db6347a4542c5588\",\"/knowledge-medium/src/utils/memoize.js\":\"88af408e5e681095\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"65f27ce29d8655ec\",\"/knowledge-medium/src/utils/nameList.js\":\"da48bc0374379985\",\"/knowledge-medium/src/utils/navigation.js\":\"988124de48eb6342\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"58718ae7bb032ae2\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"05d3ccaee8634cb6\",\"/knowledge-medium/src/utils/panelClearance.js\":\"ba370928f66c5421\",\"/knowledge-medium/src/utils/panelHistory.js\":\"114c9b578214873d\",\"/knowledge-medium/src/utils/panelLanes.js\":\"fda3463ea515bbc3\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"36a2fc1ed9329184\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"0d3949d264c77bed\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"435e2e86fc02c483\",\"/knowledge-medium/src/utils/platform.js\":\"f6e0c4daa004d155\",\"/knowledge-medium/src/utils/pluralize.js\":\"afd1a13bfe18a512\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"5c36781b872bc6bc\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"4d1359700b24fadb\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"d1ff5557d8ee8d43\",\"/knowledge-medium/src/utils/react.js\":\"3132655c23f9d036\",\"/knowledge-medium/src/utils/relativeDate.js\":\"1245cc352772f48d\",\"/knowledge-medium/src/utils/relativeTime.js\":\"b83b7013e86a8f6b\",\"/knowledge-medium/src/utils/renderScope.js\":\"77f1eaa70c5a7c3e\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"b9191278bd5b1bb0\",\"/knowledge-medium/src/utils/routing.js\":\"2ec44850b2341e0b\",\"/knowledge-medium/src/utils/safeMode.js\":\"935c90d2ade8760b\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"880c38842b3ff29d\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"a3ef615342d4aa3a\",\"/knowledge-medium/src/utils/selection.js\":\"31c3e887e5c0c215\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"55a742eeaf10a225\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"508ecc4e726d4f17\",\"/knowledge-medium/src/utils/state.js\":\"c1cd2948d083e15c\",\"/knowledge-medium/src/utils/string.js\":\"addf72de52386654\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"c8fde50561dcb02f\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"481a75335f5215c2\",\"/knowledge-medium/src/utils/toast.js\":\"b00393a47c5bd61c\",\"/knowledge-medium/src/utils/toggleStore.js\":\"8b76a3e15d5d6d61\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"9e206c9b502d1386\",\"/knowledge-medium/src/utils/userActivity.js\":\"e8b7350f47be2fbe\",\"/knowledge-medium/src/utils/viewTransition.js\":\"99fcd0c7d81dd65f\",\"/knowledge-medium/src/utils/viewport.js\":\"8419be88ac2dc4af\",\"/knowledge-medium/src/utils/webLock.js\":\"7dbce440e802c15c\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"1948a07ac435008c\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"25be0281d05b367a\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"c2839be97bf7c551\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"1bb2c48ea63be701\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"5847c0bd00f67791\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"a3c627d153d4f4ca\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"fcef1194f863746c\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"90fd7c06b6b0ea3a\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"e7eef6ac59f63e8c\",\"/knowledge-medium/src/vendor/react-dom.js\":\"195039e2faef70dd\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"64260b4249a7376f\",\"/knowledge-medium/src/vendor/react.js\":\"ca30d720db80dd35\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
