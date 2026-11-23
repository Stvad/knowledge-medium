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
		buildId: "dae341ac0afb-767bb7c1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"6111f03c3210ea7c\",\"/knowledge-medium/index.html\":\"6111f03c3210ea7c\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CDjA44s0.js\":\"1bb1a0b23c6f8176\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"bc19f4830e96007b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DzicZacW.js\":\"d6729d9e889f9a81\",\"/knowledge-medium/chunks/FacadeVFS-C3lbUBwo.js\":\"f7e20caf5509691c\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BhMXDKFB.js\":\"08ef6201d1d209e0\",\"/knowledge-medium/chunks/MemoryVFS-BwVKufP_.js\":\"388ac7e1bde8812b\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DLspgAzd.js\":\"7efbeee60596db82\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BOAsVbXt.js\":\"8ebadaab206498cc\",\"/knowledge-medium/chunks/Preview-DOyZJK8U.js\":\"8e565a8966fe877a\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DxBZzbiV.js\":\"0e632c9e3c7e6fee\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-vLf_NMp6.js\":\"d133c00eac7aa2fd\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B_isnhzH.js\":\"0941cfacc41ce611\",\"/knowledge-medium/chunks/react-BsWujx-7.js\":\"7b654710f58738a3\",\"/knowledge-medium/chunks/react-CJ_VS270.js\":\"6e7fe17911178966\",\"/knowledge-medium/chunks/react-Cd0svi5S.js\":\"6159bd8f96830e20\",\"/knowledge-medium/chunks/react-CotoN2j-.js\":\"e385586eaac3cea0\",\"/knowledge-medium/chunks/react-CtccxOKF.js\":\"9ad1e42056f11890\",\"/knowledge-medium/chunks/react-Cz78DCwy.js\":\"3885904359da32e5\",\"/knowledge-medium/chunks/react-DW69WtRj.js\":\"43223d7776a7e988\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DJ8Lotdt.js\":\"3b7795f9f1ebac54\",\"/knowledge-medium/chunks/react-dom-server.browser.production-54YNL3J3.js\":\"c46cf445dce453d3\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CGrtw6tF.js\":\"a772387ac0512e96\",\"/knowledge-medium/chunks/server.browser-C_86J-0F.js\":\"20518bb551df381d\",\"/knowledge-medium/chunks/textarea-BIAgZpUp.js\":\"0390004fe7564542\",\"/knowledge-medium/chunks/ui-B0_G2QIL.js\":\"265e51d84acafe1d\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"a13d5d7702347804\",\"/knowledge-medium/src/appUpdate.js\":\"df31b38501589bad\",\"/knowledge-medium/src/appVersion.js\":\"62bf628409f3a9a8\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"8e0607ec588bb8cf\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"7445e8d020655c69\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"12fbca2850d8c920\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"6fd9e2d97b55e439\",\"/knowledge-medium/src/components/BlockComponent.js\":\"0751d38ebeb00c68\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"d4695d9a7a5b6f04\",\"/knowledge-medium/src/components/BlockEditor.js\":\"fa39c3bee1531766\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"8c29f9d35dd3a4e4\",\"/knowledge-medium/src/components/BlockProperties.js\":\"e65285c0b7abf30a\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"a83a9baa5833401a\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"e60e184e6920fc68\",\"/knowledge-medium/src/components/DividerHandle.js\":\"471c7f37718fb1a2\",\"/knowledge-medium/src/components/DraftEditor.js\":\"caa4034e9e238d09\",\"/knowledge-medium/src/components/GutterPill.js\":\"395e45abe6650627\",\"/knowledge-medium/src/components/Header.js\":\"76aff2e4673bf865\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"a502557e1bea7151\",\"/knowledge-medium/src/components/Login.js\":\"8b4bfa6ed78d221a\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"b22486a80b8a8082\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"f3855f5f05cab227\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9aa09ca9191d6845\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"56d20b04766fdefe\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"a1e82bbf7d1cfe3b\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"20e7c862ac58e2c6\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"2ea3d3fba43544b8\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"5fc0d60bec6e28dd\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"49a6dbab59be1bd7\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"9f7c183699670c1f\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"aa2703604dce3617\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"bb6dd0850ee0bdd9\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"5dab3a93fb501e56\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"a3b1602494984248\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"52543fdfc7584953\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"dbe98abbaeb7dcf0\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"ba9704c92621f002\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"d9321eb254015168\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"0fce079078a5965e\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"877ae2e77fd96f92\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"cc0672ba9bfa9d54\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"92ae5a5b4a59b390\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"838e6fc95777fb2b\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"e20ceab55bd43a87\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"9c7774365ad8102c\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"c61e6d4221404229\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"c7749153c22f9682\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"0b24f808904fd225\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"56a97518c12abddb\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"8eaa646694277d19\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"27fbf552947c9ab7\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"a3345daeecd45de8\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"b89b61139f67dee0\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"0a98d56121b7b0d7\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"1647f040ae5add52\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"40d9d4c3e8cc31c8\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"1eab0d6a75d926ab\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"a128d2554e0c0c20\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"e65da66196b52191\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"dbec1fb021a00c9c\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"14d6e9c1578c0389\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"368fb82d33adf849\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"3f088a6bf553bd36\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"8cd49b10a3f9385f\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"6976cbfac763c191\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"4428ec5c19d9c892\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"0016fb2997075599\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e287ac30ff03ca26\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"de52cbc41aa6ad70\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"c11481d6b5a117a3\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"fe7ec0c2eb5412cf\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"0b657fcff153c777\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"21bc560fcf0cc295\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"45394f7f432c9058\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"673cf0de687d819c\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"464d4b781624d50a\",\"/knowledge-medium/src/components/ui/button.js\":\"b5dfc1f9ccf60db2\",\"/knowledge-medium/src/components/ui/card.js\":\"a8e1dbffaa6fb2c9\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"8a2e48f244d9c460\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"6de7794ca893b81a\",\"/knowledge-medium/src/components/ui/command.js\":\"000505319c9a47cc\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"6f0da1d03c4b6e10\",\"/knowledge-medium/src/components/ui/dialog.js\":\"63cdda2556b94747\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"869ced6aa6a21416\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"983889dc4f5126a2\",\"/knowledge-medium/src/components/ui/index.js\":\"fc408dd68c5dc2b3\",\"/knowledge-medium/src/components/ui/input.js\":\"8fa420f90c2792e7\",\"/knowledge-medium/src/components/ui/kbd.js\":\"699081f591f0b131\",\"/knowledge-medium/src/components/ui/label.js\":\"adb6720d8d1ca581\",\"/knowledge-medium/src/components/ui/textarea.js\":\"585a521a49934830\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"cfc51fd56828d578\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"18f2e98721055476\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"c0b889f2162cbba1\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"6707a497686c2f0c\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"135fc1b6df56af39\",\"/knowledge-medium/src/components/util/error.js\":\"7fa7771dc9fc179b\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"a342458af4cf9064\",\"/knowledge-medium/src/components/util/suspense.js\":\"f38c5ee73f6cf931\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"33724acec212a97a\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"f9d78d7389468c60\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"c9e19c972da7b7ff\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"c509d3e122af85f7\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"f109254d030ce539\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"5817a276ccb0da5f\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"13b49d78e76523db\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"a277955d83ad1da3\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"4abc3edabbf0c628\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"9ad293bd35ba35f2\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"056773d6bbbb0f42\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"99b3512b25b005f2\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7fee30d190e7f21b\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"225822f660c5508b\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"ba50dd90fc2c2d8e\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"af4b63ac5aaaf7e1\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"e1b2971c55541e0f\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"68bfde4b2ff1f83f\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"60567e4fbae38a3a\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"338cdbd413512bb5\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"e725d5a19506c898\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"348454c36fe780c9\",\"/knowledge-medium/src/context/block.js\":\"1168b441667be1ff\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"4fd3d15714154d34\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"d5e552c6e8eb5db4\",\"/knowledge-medium/src/context/repo.js\":\"5d84bc9bb91a283d\",\"/knowledge-medium/src/data/aliasClaim.js\":\"14a5c4f7d96036ce\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"5bcdae929f649642\",\"/knowledge-medium/src/data/api/blockData.js\":\"a9953274327a34ac\",\"/knowledge-medium/src/data/api/blockType.js\":\"c2d9e9626103c832\",\"/knowledge-medium/src/data/api/changeScope.js\":\"c7f730144de6356b\",\"/knowledge-medium/src/data/api/codecs.js\":\"47bbf2db4c81a6d8\",\"/knowledge-medium/src/data/api/derivedData.js\":\"9f1a6908390eebec\",\"/knowledge-medium/src/data/api/errors.js\":\"c111b8cdd5f0a430\",\"/knowledge-medium/src/data/api/events.js\":\"9eaaf327d2ccf8b1\",\"/knowledge-medium/src/data/api/handle.js\":\"2e18a11d8ad90e9c\",\"/knowledge-medium/src/data/api/index.js\":\"5ef7f846a16788df\",\"/knowledge-medium/src/data/api/mutator.js\":\"5945941587d30b37\",\"/knowledge-medium/src/data/api/processor.js\":\"5a6621df97d95fce\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"21d032413145eef6\",\"/knowledge-medium/src/data/api/query.js\":\"9c4af76b61076bbe\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"903871df78a49617\",\"/knowledge-medium/src/data/api/schema.js\":\"2e18a11d8ad90e9c\",\"/knowledge-medium/src/data/api/tx.js\":\"2e18a11d8ad90e9c\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"0f0dc6cc190aced0\",\"/knowledge-medium/src/data/api/user.js\":\"76a9724f7d5b2316\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"514b46ad526f4968\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"5d86b94e634979e0\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"2ed5d906583ffe48\",\"/knowledge-medium/src/data/block.js\":\"b57957cfb4491fdf\",\"/knowledge-medium/src/data/blockCache.js\":\"9a4b51197a562c6a\",\"/knowledge-medium/src/data/blockId.js\":\"ac713c6876be1673\",\"/knowledge-medium/src/data/blockLiveness.js\":\"c6ae4732591d48b9\",\"/knowledge-medium/src/data/blockMerge.js\":\"f56de56a787c2c8a\",\"/knowledge-medium/src/data/blockSchema.js\":\"313e7257fa7f1d59\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"33e61a00d6b730a1\",\"/knowledge-medium/src/data/blockTypes.js\":\"5ad580a1a6158056\",\"/knowledge-medium/src/data/childrenView.js\":\"ac60b7559dd1cf8b\",\"/knowledge-medium/src/data/clientContext.js\":\"e5913b8ded6e0710\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"9c352433e9fd572f\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"62e7e0b9442eae6e\",\"/knowledge-medium/src/data/derivedIds.js\":\"b35b2994707b2197\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"ace8c2ac843776de\",\"/knowledge-medium/src/data/facetBridge.js\":\"7b940d5b7883cac8\",\"/knowledge-medium/src/data/facets.js\":\"382360732840c14c\",\"/knowledge-medium/src/data/globalState.js\":\"2d68f5c08107201c\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"f643e76bf549b5b7\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"1c597a1252a69bc8\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"e88116cfaee08f63\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"c31b23173d4e9446\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"cefffb2e090bd222\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"2e00469c0e7ff870\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"6d2d363bc6997dac\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"95b6900b3f6f4deb\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"b29c37fca81f4923\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"2732cbcb48b5c2b7\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"443282812a198ce1\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"7fd10904835acedc\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"fdf07db4323b776f\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"430b5105e1f21c9f\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"6b7bd314667e1105\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"10e85ed2638b72a1\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"2f8aa09719f1ecb9\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"ca1f566419d4206e\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"20c127b703625a5f\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"424152ab05e68ed5\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"3125fce3b6fc5e70\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"46f1dbaea85c76d9\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"0d5c421b686371b7\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"2da3f56a17d1836b\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2e4ddbed769d8862\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"a5e21f6e292f731e\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"193d0b9301bc9fab\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"02ff19cd38dd686e\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"2db4f5cd6135d16b\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"2edbfdee9d441b88\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"084b2b0887506561\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"c773ac9355d59570\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"d09c9674f6f182bf\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"7d10d7231e4fbe2f\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"0e6d1c9e8cdc780b\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"be6ae113e544c60b\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5a31a86850b17a06\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"f5ad1ede280202ca\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"f7d2e96f03f0751e\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"bc5b9b608f56d3c9\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"c06a71fa6f8b318a\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"01bd36c479665519\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"2788497b647ad8cc\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"88c373f6ddcb3117\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"9c45072df39167c2\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"380b73b65bd525cc\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"2aa0fde31eaf8e4b\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"a3a27ee319e5cdc6\",\"/knowledge-medium/src/data/invalidation.js\":\"09d09b2564d0ac63\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"f36b346c7074afa1\",\"/knowledge-medium/src/data/kernelPage.js\":\"275320cb90dfb13c\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"e201eef1ddd3cdbf\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"d5921d274402aa34\",\"/knowledge-medium/src/data/localDbStorage.js\":\"e4b84c60e782c371\",\"/knowledge-medium/src/data/localDbVfs.js\":\"3d3e7b350585ad83\",\"/knowledge-medium/src/data/localSchema.js\":\"d79b54e591bc7b73\",\"/knowledge-medium/src/data/maintenance.js\":\"0082a48d67f519e9\",\"/knowledge-medium/src/data/mergeProperties.js\":\"bf9fc3eabecbb3f2\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"b189d9983778cd15\",\"/knowledge-medium/src/data/migrationsPage.js\":\"25848eec41c563da\",\"/knowledge-medium/src/data/mutators.js\":\"6b5fa901b8befb3b\",\"/knowledge-medium/src/data/orderKey.js\":\"7e7a5c110f6a6ad3\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"2b51b765d5cec163\",\"/knowledge-medium/src/data/outlineSurface.js\":\"00f45fcef7b74e1c\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"a0c049d1ace825df\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"13d80cbfd7079ee5\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"1d0f73cacbefb7f2\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"ceb0a3b8958ef5cd\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"d74b85d381773b80\",\"/knowledge-medium/src/data/properties.js\":\"e1b1afeb946a8bb2\",\"/knowledge-medium/src/data/propertiesPage.js\":\"f4dabdc61e63ac08\",\"/knowledge-medium/src/data/propertyChildren.js\":\"57c290aa571f29c6\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"8a615b427a880d7f\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"38777ec7531ebc63\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"1a237025fda20b8b\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"242a546c79a6af71\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"7543f009d63f5eac\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"40157064210a9ab3\",\"/knowledge-medium/src/data/propertySeeds.js\":\"03d01fd62e844048\",\"/knowledge-medium/src/data/recentsPage.js\":\"ad24eb4fd331c391\",\"/knowledge-medium/src/data/referenceBlock.js\":\"a5b3bc6466c2ddfd\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"18f402950829be1d\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"b417dcc84504f5bc\",\"/knowledge-medium/src/data/repo.js\":\"10da15681e30aa45\",\"/knowledge-medium/src/data/repoProvider.js\":\"6e1ee7e827cf584f\",\"/knowledge-medium/src/data/rowProperty.js\":\"ab13300481515fb1\",\"/knowledge-medium/src/data/searchFilter.js\":\"70b6be744a15d6ac\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"aafa43a4548a3a35\",\"/knowledge-medium/src/data/stateBlocks.js\":\"d50814ee69cf0848\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"c32b85dd1c576b54\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"470605717e64878c\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"2cd2bcad26437b58\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"baaf7a9f1d683c7a\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"0fa7d41362738bea\",\"/knowledge-medium/src/data/targets.js\":\"d17c8760bc156f76\",\"/knowledge-medium/src/data/typeColors.js\":\"3a8fc097596f34cb\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"b1fc39731b71ec0b\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"a0214dab3fb6a357\",\"/knowledge-medium/src/data/typeExtraction.js\":\"7c84cb114d6e402d\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"d716b29e51329b80\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"e51f0dc9aeef8196\",\"/knowledge-medium/src/data/typeSeeds.js\":\"ca20b2a8b461a7c8\",\"/knowledge-medium/src/data/typeTagger.js\":\"2b067cf02d4150ee\",\"/knowledge-medium/src/data/typedRecords.js\":\"b3f7703b985f7d61\",\"/knowledge-medium/src/data/typesPage.js\":\"0252ffb94784eabf\",\"/knowledge-medium/src/data/userPrefs.js\":\"5462dfe5ffdbad52\",\"/knowledge-medium/src/data/userSchemasService.js\":\"7cee657ab722dd19\",\"/knowledge-medium/src/data/userTypesService.js\":\"ed1b95c2a4dc58eb\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"d2ad63bd7bee7198\",\"/knowledge-medium/src/data/visibleChildren.js\":\"fdb56694fa64a61c\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"c9785a1881ecdf84\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"ab32e0151171dbc4\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"d606c12bc2bde488\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"cd6253c8cfb68b1b\",\"/knowledge-medium/src/data/workspaces.js\":\"c43d8af01d366aab\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"414c098e21459acc\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"dd7fca075f182f06\",\"/knowledge-medium/src/editor/atTrigger.js\":\"7836cc2d872f8652\",\"/knowledge-medium/src/editor/autocomplete.js\":\"aa738e97f3860446\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"2cfb98f6b7f2ba3e\",\"/knowledge-medium/src/editor/contentFlush.js\":\"407020a0a92d5383\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"a2562998217e9fa1\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"fd783f6d235b0863\",\"/knowledge-medium/src/editor/insertImage.js\":\"1f5bf4513705b20d\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"1a92730b4e3d4bab\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"76c7e8bbb90c5ed0\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"6b85c77861a6a76b\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"82688e85b2b3af12\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"2246efedc7514f95\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"d7554400cd19dfc0\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"d5123e526a68651f\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"71e9bb5d0b5ca3a3\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"729f3bc235815070\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"cd7b5c017865daec\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"0559e00fef17d3c5\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"19ae015b98be8b88\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"54dcd6f38c0ed832\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"7f444ec40fa0334d\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"5cb1a8293e38e471\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"b2b2bcd49ab0141b\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"8707fbaafcc7a676\",\"/knowledge-medium/src/extensions/core.js\":\"ad83412e47b007f6\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"ffdea1460e735c2c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"5bd6097aed102d5e\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"7af850adca961c08\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"a664ac17a3158b9c\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"470238d65af6172e\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"e99c03a84e209584\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"cbb3b2150885242e\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"6030475688a0c2c1\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"7d12670708a8cb52\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"feaed19a063a82c2\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"9e9e7fe152494a93\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"62cb866e9988acce\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"e79b02f87fe431e6\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"7b6e954775394277\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"f3b9f8906bf16a7f\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"ca101169f67ffdc4\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"1501d25e6e591bc8\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"fdc631295b80aaeb\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"08eafe68a99ca08a\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"8c8edb32a9fecf4c\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"d350ed5d1daba384\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"e9148aa5a1e41bc6\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"4b5dae5d4398ad39\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"086b5112dcd6a5c9\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"8f5589ba6b2ffc7d\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"7118484fd1f0db20\",\"/knowledge-medium/src/facets/facet.js\":\"1fbfb20784b803b4\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"d34ddc01ac6954d3\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"014619879d6ae734\",\"/knowledge-medium/src/facets/togglable.js\":\"01573d514373f5a5\",\"/knowledge-medium/src/facets/variantFacet.js\":\"21b1875d19349f93\",\"/knowledge-medium/src/facets/verbFacet.js\":\"f1a69256d02d4730\",\"/knowledge-medium/src/hooks/block.js\":\"ba15dd9d5bc37db0\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"30cec1e8a89c6faa\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"4212c900b13b92db\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"8fd7d75b17bce42d\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"8d5402508d17b3cf\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"63645c02521d8145\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"40d64002f89ec163\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"46a7a4620042c892\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"dbe2310c3a47bf6a\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"f736048e9905312c\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"356ca08dc2877881\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"17a4c715f16db577\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"bc4dd940180c0ebb\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"511b75ae804f6fb1\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"72b014a431acd529\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"30b45dbaba176ccd\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"33b62fb1f52cdf91\",\"/knowledge-medium/src/lib/utils.js\":\"48672cd2f1ab6582\",\"/knowledge-medium/src/main.js\":\"b4305c2b15bc8307\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"bb4079ef7f915ef4\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"5d6a670b281b9818\",\"/knowledge-medium/src/markdown/context.js\":\"8b18b7b30253aee0\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"3834e21f49321f0b\",\"/knowledge-medium/src/markdown/extensions.js\":\"e2a3f30ea686896e\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"f1222cb255bfb111\",\"/knowledge-medium/src/minimal-editor.js\":\"49a3257d3e115bd7\",\"/knowledge-medium/src/paste/armedCut.js\":\"be9d871469af874f\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"19f2c3acabd8bac8\",\"/knowledge-medium/src/paste/clipboard.js\":\"6b78eddf03c18cda\",\"/knowledge-medium/src/paste/decision.js\":\"558616f5ac8cf737\",\"/knowledge-medium/src/paste/operations.js\":\"8e210c3d3ece93e2\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"ce5811584457f761\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"ff0a8aced1048f98\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b7ce7941f68798a9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"0bc06e43a50c4d6f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"2427ce465933c25f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5def3748354ca937\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"2bce500b5dc95bc6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c1bd333f4f47dd4a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"42bcc56276d01862\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4d0478834d25b38f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"02719cb7ab4aa387\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6a7deadb48a9e011\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0ef8921d9fb037ea\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"3dd066d61c8dbb04\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"023ea4b3366105e2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"ca0248b7c578d342\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"09cd35bdbfca5d1e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"158cdf616698c3b7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"b140e4bff7d37986\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"2a74f0803f069269\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"4d0b34e538d7d041\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"a625994ba7d4d41b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5f2096de9aa2ee5a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"590c8dae55b172e3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"2aeb2da550965473\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2bd1700feb2fdde7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"d208dc63c673068f\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"0f1188171337bac1\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"2069381c415dbb8a\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"95d75db82c0bf284\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"93f8455db0edd50a\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"2504d6d5c037e3ab\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"52e7ca4417171584\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"e0a182380b414cd0\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"08ba979190eedf19\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"6c8a8983a2e2fd53\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"aae4f0db177ae379\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"fd4976e94492b470\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"1e30f9264b002f77\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"529aebd4dcaf182f\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"140edf29f5193bbf\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"a30eb0f3ea3e5a8c\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"a23a4b64a771ae44\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"fc88453af11288ea\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"06e06aee6e2efa1d\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"9cc243aeb40c33bb\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"9a0e0399af7255f2\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"68440f5574bc3a42\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"8d8ea28e91f4910b\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"95f8d37164723a31\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"ffea4b2507ec00aa\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"d3780ed96c5ac813\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"d98e79a96222591e\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"dbfde7aed03f6eb5\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"19aa04da19849b64\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"c5834e9d29df5ee4\",\"/knowledge-medium/src/plugins/alias/index.js\":\"288157496eb9b498\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"73a3bba65bfab54e\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"dd041943ce477cc1\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"1cae05b9ff877453\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"069888306bfb76aa\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"4d48076c5b73d810\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"23989d7ef6977332\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"d3b807230ed3122c\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"b4bf21bf919034fb\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"a44da385d72d4706\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"0ed351a4d14ff443\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"4bf724d5d68903d0\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"0c5c81a32423b52b\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"fc10d1c7c2e7f68b\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"156d8dbb81c4d5bb\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"cd2e35b0c494513c\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"e8f9cc3d7b12acc1\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"a1552b2b3ed8dff1\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"1bea6ad7aadd5874\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"c2f72adbc9a39c43\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"abc6741ad4d0feb6\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"976f626d4655e7e7\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"a7aa60f6b25b2177\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"223877e203ce8b2a\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"c90d22db8e3aec08\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"0200d2f84fdc4dad\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"313be00e9eebfbf2\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"46e21362da1e3155\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"00cbc2389f95af63\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"fa1c4370ad71c21b\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"91f7e3634330020c\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"3eb4cfa0c0a041a5\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"725a6761a22b1c79\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"e2846d3068fa28fd\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"f735aa7b80613137\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"7d9d72b8b854237b\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"ce95c242bc3bac3e\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"9478b3e48d186cc3\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"693b4a80a23e6edd\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"244e8b2c99fa8ee0\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"7a9a68166bf55dbe\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"fd9736696fd37b8f\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"2829d0d71bc01656\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"e1b30fe4f42fd606\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"8d08290e1d268c21\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"fd2cd4e5215cc672\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"c33ff25209ee278f\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"db2444463a336fca\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"2c6edc58206f5f63\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"7135d1bafe03abb0\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"818c351dbffcb7d1\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"66fb284fbaa4b71b\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"8702fa7593f64820\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"c48aaeafb33df55b\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"2ea1eb4d5cf2d247\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"2f086d6a9afdfa44\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6cbbd14f14b7d19c\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"c00798165c59f7d6\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"13583c68907f1c0d\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"e8326163409b9771\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"5249b5288d73a455\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"62e30264184c1392\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"acdb5e79a4d9a4cd\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"3048bd897dacef2b\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"2815c6e123d1e69c\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"1d50758ddce8749d\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"9be7b65f305217c6\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"435c7b44fccb315b\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"9bc1c1b613f1136e\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"e3b725912dd6a0d4\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"171c32fb48249150\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"79cab27131a09884\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"f9ec2e6709fd005b\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"47299ca6d5c7360c\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"4259b8b7bbba710e\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"66dc37ed7ac6b32c\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"342292555c84f714\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"1411148ace0b1d7f\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"2f1f9d175b051019\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"4eb3b1e65adb180c\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"7d0e61d2f6d22f5f\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"00715d7a8c5f1dad\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f1e141fbeb72f1c8\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"02647725225efd5e\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"eb70ff1fc7bd1e15\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"b9dfd189bba932a6\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"37da1909acf3dfd0\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"9e4b3bfead515577\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d9dfed14a913f238\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"dcdb2cb199df33bb\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"4e87a1682aeb4d71\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"64d955ecfdbd90c4\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"bb3cd44c8bbffa93\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"4b576004ebd8df36\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"0648607fe4bd44d7\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"4c6ea7ae8a1c88a9\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"de3d0ead9abc5a16\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bc7e0607260d46dc\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"970881b2d9f53ed5\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"5abb10c421da0658\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9480e83468c589bf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"cba1fb9a0efdefcd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"40cf12e7ce58b717\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"f9778baf38bd346f\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"b66aeaa9e8099e8f\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"4769918c92db0630\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"e52c61350d7f79b2\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"4f158136024c4010\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"6c2eab9010eed9db\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"cb8028ae4e1361a2\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"073e85bea37af9c8\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"66c7af4e1a1e8df4\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"04d09367df15a748\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"6983a39d012b8bd6\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"e700dc27aef23904\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"68af91a9e71ac31c\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"5575bcf80821a179\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"bff40aca13163736\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"badcc183370b0b03\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"b0765c42e269d4a8\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"e3382ae179d4209c\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"2e47ec5d314ebf5f\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"94043c9f2731440d\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"9e86f9af84569590\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"79edf8db50658cbf\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5fdc57fcc027b214\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"2a36b8582b16ed6d\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"8d6e7482da6abfc6\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"f3387632166038f0\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"a032ddb0d2f4f329\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"68b56a50b495a6f1\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"8c8318c0a652c723\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"210e709e6cf252f0\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"cc239eb3ed3359e9\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"4889e7dcd60d1b67\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"7ccfda7e752cad77\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"68863a73507c862c\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"6c12620f9ea5523f\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"c5ca0d02d74c5088\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"05b0a3956cc8c957\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"a5371a4ad8e04ad4\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"30cab7baf5ccd670\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"bb9315dd036b8575\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"890998923c255c45\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"0216a0d2f786ae42\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"8f10a4a389b833db\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"464c56595ec9ccbc\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"8ebaee42b4a8f49c\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"f8e3606b5d280871\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"eba4a728d5901073\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"963e269946184b4a\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"2cae89859497ac45\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"171f7ae9d0a31848\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"e6d4db2ff9a7199b\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"db5c8edc6c350257\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"3d80c45a29893108\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"6979ec66e21b6d54\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"9891182af7332d8f\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"3f2c8c5c8875ee27\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"70edbdba2b564650\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"f3a1181a10d09cb4\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"0f01b6364b0b33e3\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"61bb1b02cb4fd690\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"011a245f8054e497\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"5fd79bebd4309d20\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"af86f6733819e56d\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"415b0f8101e27829\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"eb957053a672e903\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"fec02b3a3f1772ff\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4b2ed426c9b56965\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"3a83fb088814617e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e179afb289ee2833\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"47fbfb66a5fdc70a\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"4e9359c106f02d16\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"b6e478ccfe08bb37\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ee12f51f08b6a317\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"aceaa8de2921d9d1\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"df28558e89ce81bf\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"6ac156806e9251ab\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"a3b30e3ebf07da98\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6a19cfa70ba12a87\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"f7ce24fd0a31bae5\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"8d4645d6db01c824\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"2acdd2e3715fc5ca\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"99b0464d6bdeed53\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"889efe07f7fe1f10\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"dffcf4723fb5a51c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"bfdbe6374912e6d7\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0835b9be876cc100\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"7b646fa623e9acf4\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"3c335db4510cea53\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"80a3018e9a84a784\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"8a4daed25ac6c568\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"18c5964bea8f9313\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"3a747b2a535c55f4\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"39352ac503d388ec\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"1194cfd5c6f2d662\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"163f2551070916d1\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"f90e2be371cc41bc\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"77bd51a35b1d6bd4\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"b006f114f13a0d74\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"746274c49308931c\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ef9a7fe278dbc103\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"9d5281caca61f963\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"1d89aa38fa564000\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"8c0eddf433208b51\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"61f3b5e52f3018b2\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"8f7887ec1c7db25e\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"ded45cfee20e7655\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6c3d450bce2e938c\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"87cfdab5ac920a2f\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"ce2ea4fd2ec380a8\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"cc07ba1f2e4394a6\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"3a08a31e4eff5ec2\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"4f2e45ca611efc76\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"7b2b4f5940546a45\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"6d01a5518b684e8c\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f48c0b2a8ebaebf3\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"250e4f4087ae5325\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"ad853bfd4aec6d5f\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"76354f4e600b8042\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"e8d4f61acc1557d0\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"38a886aee03f8e19\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"47849fd377a5a184\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"87dc39048607adb6\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"6b38f03b3e275dac\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"0bbfc0e02b893e5c\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"46151c75ebe40fa0\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"0804e10178336b6d\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"df1803c9e3304ec7\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"ca101178c1de2baa\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"e2c9bffa3055f220\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"05453b30f09a0aaa\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"32d063388f264ff8\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"72fa602a252da454\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"1dd700a7b3cdb257\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"a941eb6fb3836f90\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c3e450e64c71aacc\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"acb203ffca95f9b0\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"7e603ba00ebfc26c\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"b628a844b126fd54\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"a3fded438c600596\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"1e31b97a1c36fa47\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"846b3be2bc4c949b\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"52b15780f37aece4\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"48f3f1ecf3b6d106\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"d55cdaf6badc0af0\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6b1f1c0e799c786d\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"ced1f7131159c540\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"a5e45b5694a841b0\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"f44c31ac7ded99e6\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"a730af0a508ed513\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"97e64d9d580852b0\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"679fef15b1b8af31\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"09277b8e07af049b\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"4a53b5ac7932469e\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"d25b55835ee88fbe\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"c3acce1889f88b86\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"49ba70346013b27b\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"0421e8df184b3625\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"fd96cfdc58189168\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"71b73d0ce920086e\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"545218a1e5c26ad8\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"5cee1c5051486852\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"4a6a41b8f8d0cb2f\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"11d8646728af0e42\",\"/knowledge-medium/src/plugins/geo/index.js\":\"569e657584f334c1\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"f9b5b514f52b38e2\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"932ae50842d5b2d9\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"24b73805a9d2b23c\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"8d7c375040182ad8\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"c7d979126322d616\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"4d6bb0e86d78847d\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"6aee750a45a004e1\",\"/knowledge-medium/src/plugins/geo/query.js\":\"851552ceea402218\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"f364f73011740e4e\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"0669fb14b4e70319\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"06927955dd1e8e7d\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9348695d04102b3c\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"dd3737f05d62c030\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"ccca86c2284f591c\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"13d74c43909e5005\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"9b4d73044bf79f3c\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"6b2ad9fabe04333a\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c6524353b1fb817d\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"8f13fe9f0454b442\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"838c889fece0c673\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8ab3811ce6c29f35\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"06d42fff07999852\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"a0501c645528dd90\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"8411e0e6c38fd5ed\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"da9626f0f2b394ed\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"19cc1c69dc073bf1\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"0a7b068654322f9d\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"abb10481a78a93ee\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"ccf8eadb43a13201\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"5ae4fb5d4a939877\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"11cc26b4d00b469d\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"13ee3b3da21f059a\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"ca2b4ce5738deb66\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"59f7cb30c993a160\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"5e9a0b381ea763a1\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"67fc9bfe0af38f1a\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"8352f3b8a4fe3c69\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"c43d411c8597f1cb\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"52a624c8c8ca5125\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"bc3beac038edb4b5\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"6305364d4c34a6fd\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"69874befe6d79495\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f5e857cce2fe26f5\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"b218188c428af5b6\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"2360d15034993f8c\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"09d68d1982607e54\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"3fb313761b767c39\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"bea72d5d5aede342\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"9ceeae7e9f2ddd9b\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"84574ea0ff053fff\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ac0aec4bdff54f75\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"b4b69b000f1770cd\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"7b7708ba347796c3\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"319d50e520a45646\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"dabcd4657c5ed37c\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"c02703b6394f9b1b\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"30e3632066eb0ea2\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"be21d5ac031458e9\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"a9f294a7aae3c2cf\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"dd1d0b9122359eef\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"68c615814f2a8ed1\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"ddfba0712afa709f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"717bc90a00b34eb8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"85eda82edc1c1407\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"480d16948796af9e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"1abcdfe05cacc553\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"18f922cbcd153835\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a99869cefb928c40\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d114a0e4e0f36d33\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"de3cb85951761487\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"dff46c83b26be1b1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"f073eb946e55d00f\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2a302b96af114a18\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"dcc3ab6680adc4e3\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"bf1ba9bda3e47b1c\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"50670853fee74025\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"2f7283dbfe1432f1\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"6f3e6ac1207361d0\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"324b911af3194320\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"587dba4a2853713b\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"e97aa9175b468ebb\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"39f6c425f8a45869\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"1710677bb9b2fef9\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"ce15adde66534caf\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"0b0758f3286d9d5d\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"e1b00c6425da4273\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"a301b382ba2196f9\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"bc51d37cee79a5d8\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6703e4597ba02987\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"7142daed5cebc191\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"f28d455fe5c17d8c\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"4713e72865db4e3f\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"15796dfab2a2f675\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"f54166076bd5a740\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"5d18831e51e8dc3f\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"aa36984254da92f7\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"9a3ceaf3a2707389\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"5fd736f1088cc2da\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"f513905d88136626\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"4e477a8a8c78d3c4\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"d4b2581a9b1141ba\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"dfdeb2d116e0263b\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b23ab596f4fa5206\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"adf851390956da81\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"f29f7476efb1ea55\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"b4d569e13637cb54\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"bc703a92bb837082\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"fdb5249ddc134438\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"8b1ecfbf6effbfd8\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"afd19bf0a391377c\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"fb0114186d3181df\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"a24ef8006d44f581\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"225dd27cf5c55ec4\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"0016eb14d539f836\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"f9759685dc9f5115\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"8bfa6108b460c7f4\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"a0e8a0516e493cbf\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"dbdf9e5712e3aadb\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"4422ea22fa7b49b8\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"cd7ab7ce771c2a27\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"c1d14194134465f7\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"ea3608ed4c9967cd\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"c6e2ae4c883cb193\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"211cd6f73455ad76\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"a93ab433163ba9e7\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"e9a78f0d076fa185\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"7c82b77ae6e1a2bc\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"ad451c8ce55dfb53\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"97638d10f4dc8e2b\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"2c3443ae2631e6f8\",\"/knowledge-medium/src/plugins/recents/index.js\":\"d5dac2d0f267de5e\",\"/knowledge-medium/src/plugins/recents/target.js\":\"f6df142224f63d5d\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"8294fa95b612c2b1\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"6007dde48275fa9c\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"a6d4182bb296e64f\",\"/knowledge-medium/src/plugins/references/index.js\":\"cdada3a6dd209bb3\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ba8bc6766b0ff24c\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"4c65a3753c37238f\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"badd43fc2d43581b\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"8e910d5dcffc77d9\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"86321abe6f2e5bd9\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"bf6498063ad05955\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"e469cd8cbca308be\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5484b331735bab63\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6e1cab2067c4a77f\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"425a81dee6705c6b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c98a6c73f0d9d78e\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b5f39f80bf773ab6\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"e70c810d4c6519c9\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"ca111d0fe55a22b6\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"1987e1f54f66a257\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"9756124cfcaab620\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"363acbcdf29eb703\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"55e5c7c4017ce997\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"a0a6a7185adc068b\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"e85e4da46307d0b5\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"04df54fb44cf9f08\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"bc9db0901b8987ac\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"fb1c9a5b1602d695\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"178a61636a4b2c80\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"4c4d279216263972\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"f058cbf2dc2964ef\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"38f6877522b0e1a8\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"3dd6b2c8e1df9442\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"49edb50c36fa8e32\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"dca14ce3037cb510\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"d53823ddcd7681e2\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"5f42d1b680394b27\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"80b2559e760ec875\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"c6e26aa3b09f1d29\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"d33436752c8b1655\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"0750086da643073e\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"35b029c155126b97\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"fd067fc9b0d356b9\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"cf15b4f66f57db3a\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"52d3a3939106a1f5\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"8ffef1b7d6b91a56\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"46f41418d62aecc6\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"edffe37f29504da0\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"b377c5c84588c885\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"5e1028be6d283720\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"6d9e4c036d569d3f\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"b47ac94036bf22f6\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"5ea89e2f318f2f5d\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"2081073c349c481c\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"cbe016876c69670a\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"35dcd054d07b8c29\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a6e93411a1b588b4\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"ba597bb1ee6fe2e6\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"50e0f912e5325f0a\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"200141a1c731ab82\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"404e557692b52769\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"ae0d49e95aa7314f\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"d7d0cc4560529296\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"458da416078803d4\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e64b65109f00c392\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"7db6f4a191d09018\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"d1a6ab06c980788a\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"46763b9b3f296dd7\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"aac8c86472eb3457\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bfd336cd3e6e0653\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"c29fe779fa29d74f\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"25c7d20df0cc379c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"74b4dfa60336e052\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"5f6c16af07779325\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"d3108761fb1de708\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9720120d18aa28f3\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"0c36e9cd664449b5\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"67d1e479c46c7f12\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2f86eda68776b41b\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"44bd2fe01651d6a7\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"d4a4acd4ac3dd423\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"e294ef2eabd0ed52\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"559e20e52c7622ee\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"c76b78260d4b11b2\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"0e705d2735649d5e\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"787aa42f5e8e3de0\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"a1c29b486fc8937e\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"35373f7ec4ed6b8f\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"55ce03f662352e7f\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"d03208016410bea9\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"6bc1d522a5afed25\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"cc33c73ef3d8a553\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"31d191efce37afdc\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"a2a3bcade07ba747\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"9a8c1ff062bb3ef1\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"967fa8a2fb475031\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"42bdd8b8c487b742\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"e1be72b3f64e1c2e\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"16dc60ccde815fef\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"70c8409b15a4edbf\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"42b2bdc7357ddca6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0a269079dddb5a8d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"b62ffbe5519b628d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"61fb0a85f9997e58\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"151c22997479bccc\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"6fadffb5de5504fc\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"2f9419fe460dedb7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1a7e2332a0237eae\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"135abc00c9d4f157\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"9cbfee84c198d559\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"a371298bd4db33c6\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"0fdeea3f05c28db4\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9ef1d48b2ccea6ed\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"d2d6e4b16ac5bb2a\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"8727ceaab837472d\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"c443d5281aa86ad8\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"797b5cd5c126e1a0\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"6387b66064e1e6bd\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"9b1337c24370de41\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"90b47a40f86bf0b6\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"30ac5cd49f15decf\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"2e9bf3fc3cc25436\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"9ff867e57188a8f0\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"c11d1773f7704691\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"4d62f40905ebb29f\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"62fa72e6d63b3baf\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"4c0dd6b531648502\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"687dd0e32fd7039c\",\"/knowledge-medium/src/plugins/tables/index.js\":\"1d8bfaa819bb7dd4\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"21ee9b16af210e59\",\"/knowledge-medium/src/plugins/tables/model.js\":\"ff5a8fb318cc9b24\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"f15c49f516702f60\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"fbded2abd9335356\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"5e63c6e6c9f729ad\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"ded71b3260912682\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"f34aa0c83ac20da0\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"a520504852cb2a36\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"d6fa01d478026d68\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"5706c6e79a508ec3\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"7154292e8ab3c87e\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"1f80f9746a4e2dbd\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"434e7601e161fb8e\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"ec0c91a178a17890\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"c8a60ebcdf490a6e\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"0df9729ecc60e1c1\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"4bebfeeaa7a073b4\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"5f2500e8f9d48a53\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"704598cca2b0ccf7\",\"/knowledge-medium/src/plugins/todo/index.js\":\"136dc6e46547d8aa\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"76e5617ef29f3760\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1e174e5c8e9f3229\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"7f9ba42b8b5b8778\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"65b36bd7ec6a4366\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"d9da114014de75d2\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"ead1d056efbda324\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"f4069e64b7b838e4\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"e51cc38020916c06\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"c8c4bdad0810dda4\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"e2cf43938818e62f\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"547bc6ba9e867cb3\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"edbec0dd56a05312\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"6d3b808cec79eb84\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"049cef00e5572951\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"457d0169f96bf622\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"cf37ad272070e879\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"f3e2d46f3a5f5575\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"54058c73a4fcd30b\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"5907a39235b7904b\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"287165b6d9e70afa\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"5c250813931bcc79\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"219d8f9e0697bd7c\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"54c521b38b46164a\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"63efbbbcb39e3794\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"111ae03b2a21260a\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"3d9516b22663d8d5\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"b3ec4af5f8b77389\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"585f7dd65a675472\",\"/knowledge-medium/src/registerServiceWorker.js\":\"fc11a518409d5699\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"8ccfdbd0f7621669\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"fdc3573c99a7d9d7\",\"/knowledge-medium/src/services/authStorage.js\":\"f7d4d88fcc612666\",\"/knowledge-medium/src/services/powersync.js\":\"2fbd34355b218797\",\"/knowledge-medium/src/services/supabase.js\":\"1337da97fb63e3a9\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"a912621bd5cf5f61\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"e19b63207aa82411\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"750ca32579a07a35\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"fc26676c796e014d\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"6088ea604d5843fc\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"cbd14e72a111adc1\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"bed2dc6f422125a9\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"d5e2cde1ec26fa84\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"a9e989688e4aaa66\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"9048c92813f3992a\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"cb27dd6dd9a10d70\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"465b6e0a16ad4b52\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"99c2294ba1297445\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"e9fdf2dd0349754e\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"930e81fcf5fa4d47\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"3def13d1ffc1a78c\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"bedfeeafbd080207\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"49f39e0f68752830\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"b43a52b25bc4491d\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"d5c20da3fd97dc76\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"e633986c8d6048ec\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"982f035115cf0afb\",\"/knowledge-medium/src/shortcuts/types.js\":\"1c09e336ad88d0c4\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"eb538a1dcdcccc84\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"4b1271c8001b5804\",\"/knowledge-medium/src/shortcuts/utils.js\":\"9e74a397eb829ace\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"50cd5660fd3be927\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"d10299aa9b6ca78e\",\"/knowledge-medium/src/sync/byteTransform.js\":\"69cf2d5d54590264\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"dd99d371ac26e93a\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"29460fd9b0d82fdf\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"b1c1a0c7bb9db1ce\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"02d06cee76218b5a\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"15bc7c3229dc50e8\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"754bf44c75339504\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"6936afa673191a46\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"1a9008f8229d03f0\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"a8a10485e233256b\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"97ac95f5bf3d7870\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"58c53ee97b8fe65c\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"1018fb8169180f31\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"16b1f239c2101f88\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"03b68a28731c1780\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"4f20c4134a23f79a\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"6a7478efa7640682\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"785f7a1dcd1e3db4\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"c492fda3aded6da1\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"7d432a2a44013528\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"867e21baedda3525\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"59bb42849c42f54c\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"26753681ddbc0f23\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"0b51f93d3b225db5\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"c4313a67a63ea169\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"e9602b8c2e495004\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"83d2d51e4c72f1fe\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"41bea78c09c5368d\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"c8df104e81ecceef\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"37e1e2f9377e95bf\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"c320b67d3900bffc\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"66b1adce2471e7d5\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"7d0d2426e30e3d49\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"ef4ef9a291115f6e\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"9591bf859ef33320\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"eae3e586f0969433\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"a74c3c117138e544\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6a7034d8854b1885\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"d5062862fe35ce89\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1b25e9c10d3e069c\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"05fb753840e9abf5\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"9e58da0d7bd9435b\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"ffda92136927883b\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"fae07782ac4529ac\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"14e0413bc85a05b1\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"5068b69c16ce0dc8\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"e04be87bc9de91d6\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"a24acd6b8f8be44d\",\"/knowledge-medium/src/sync/transform.js\":\"c4604a841f451167\",\"/knowledge-medium/src/themeBootDefaults.js\":\"2d567dbb51e8880d\",\"/knowledge-medium/src/types.js\":\"b83023b214b0472f\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"d9ebb275b1569721\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"2ece14fafb5ccf12\",\"/knowledge-medium/src/utils/array.js\":\"59305f23e8951aab\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"92f2ae3ca1483efc\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"a944764c8f637975\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"e31bd2163649c549\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"773002835199bfbe\",\"/knowledge-medium/src/utils/callbackSet.js\":\"6c510737d04e9706\",\"/knowledge-medium/src/utils/clientId.js\":\"d9d97856b06d5724\",\"/knowledge-medium/src/utils/codemirror.js\":\"9de06434c2b36e18\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"8e41d535cc0db6ba\",\"/knowledge-medium/src/utils/copy.js\":\"98208d055800a944\",\"/knowledge-medium/src/utils/dailyPage.js\":\"c3537846b981f086\",\"/knowledge-medium/src/utils/dbForensics.js\":\"6c19adedeed014d2\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"eada3faf9d88c017\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"129da32e84b61dd8\",\"/knowledge-medium/src/utils/dialogs.js\":\"8becdab0704ac625\",\"/knowledge-medium/src/utils/dom.js\":\"476ca8d6f2144172\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"884634e790099db9\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"f6abcb390adba41a\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"76464653121c31b1\",\"/knowledge-medium/src/utils/flipSlide.js\":\"b889862fd8ad2bfd\",\"/knowledge-medium/src/utils/fnv1a.js\":\"bce26995b1faeda8\",\"/knowledge-medium/src/utils/formatBytes.js\":\"8f7cb3cbc284e912\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"603854a463ab5184\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"a3fe0dcc7c4c3ac5\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"f8f3fce7704b0e10\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"a05fd0275ef5a899\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"f6977fad539f7070\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"f08a54be2693d0d0\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"5a40fe1876a50aed\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"09c1ecadcc37b5ee\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"6f2597a8a2bf8e76\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"440fea2f338f6afb\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"1453b7b2c7d6772b\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"fe20585e45068226\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"cd39f89392ac45eb\",\"/knowledge-medium/src/utils/markdownParser.js\":\"97aa58ff30068d9f\",\"/knowledge-medium/src/utils/memoize.js\":\"28dc4ac74c4948f2\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"91a7d5f6fc8ab97f\",\"/knowledge-medium/src/utils/nameList.js\":\"d2270a4d4b67b400\",\"/knowledge-medium/src/utils/navigation.js\":\"757c391dde04de50\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"5d41ce9c44a86f22\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"427226e94c8abade\",\"/knowledge-medium/src/utils/panelClearance.js\":\"7549475f7d67060b\",\"/knowledge-medium/src/utils/panelHistory.js\":\"a76f4417b6bd18e8\",\"/knowledge-medium/src/utils/panelLanes.js\":\"c82b052ec8261fdc\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"163bcc65f51fab24\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"922ce72f7d32f8a3\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"f5f6346f06ada149\",\"/knowledge-medium/src/utils/platform.js\":\"3590e577504b603e\",\"/knowledge-medium/src/utils/pluralize.js\":\"567b25c519532219\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"fd4c966f72d9e51f\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"ddd21129f73f9080\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"510129fa8e864eda\",\"/knowledge-medium/src/utils/react.js\":\"5285186f5ae94d13\",\"/knowledge-medium/src/utils/relativeDate.js\":\"7e1bac72a3622e44\",\"/knowledge-medium/src/utils/relativeTime.js\":\"4ed72cb1632b3654\",\"/knowledge-medium/src/utils/renderScope.js\":\"8b4f91cbe3bc7b40\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"769866896dce35ef\",\"/knowledge-medium/src/utils/routing.js\":\"6e30b41fb0543f76\",\"/knowledge-medium/src/utils/safeMode.js\":\"9141269be1b9ef0b\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"5ffbf81b4c53ac3b\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"1d1c50f2ccb579f7\",\"/knowledge-medium/src/utils/selection.js\":\"cf80743e4122b9a0\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"96a41f48c73f5bcc\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"5986ca9ea71ce53c\",\"/knowledge-medium/src/utils/state.js\":\"f091b43c427f3189\",\"/knowledge-medium/src/utils/string.js\":\"0ef45329f0c1b4ae\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"5646933bea045deb\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"f2421cf76a28414c\",\"/knowledge-medium/src/utils/toast.js\":\"207261063fd1752d\",\"/knowledge-medium/src/utils/toggleStore.js\":\"f1a9ec5ea3d2d1a4\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"48dc14c79de72ea6\",\"/knowledge-medium/src/utils/userActivity.js\":\"44fe3a4926f44002\",\"/knowledge-medium/src/utils/viewTransition.js\":\"3992f4ff1f970b9a\",\"/knowledge-medium/src/utils/viewport.js\":\"742874cfde733fd8\",\"/knowledge-medium/src/utils/webLock.js\":\"a299a13dfad83486\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"a50681db288d0a85\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"66a91e198d2627a1\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"74cf4083b0d05230\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"02ef6cc5f67b0305\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"cacc530d817ed3ac\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"0a64103d72d23a96\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"f26c192512bbdb3c\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"159dc5625a243273\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"ffb0fc5cc3501fc6\",\"/knowledge-medium/src/vendor/react-dom.js\":\"a4e6e87920285d13\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"5394010236ae4be7\",\"/knowledge-medium/src/vendor/react.js\":\"66db2f49722ece7b\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
