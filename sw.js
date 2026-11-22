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
		buildId: "eb77df8e0d67-2e8502a5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"f8855641cde7ad08\",\"/knowledge-medium/index.html\":\"f8855641cde7ad08\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CD9DKIdQ.js\":\"d931bb6cf7787ba0\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"2a83d20708f1f173\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BupQ1qvZ.js\":\"b35bb028e1803efd\",\"/knowledge-medium/chunks/FacadeVFS-Bz2bLh5F.js\":\"66de9c5ff9cb0e08\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-CusrVIH6.js\":\"b7af7df2873bf6d0\",\"/knowledge-medium/chunks/MemoryVFS-BRfxt8Lu.js\":\"4198fde7ece02d26\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-B8xGCuiH.js\":\"a5fa6378351a347b\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DA6ct_SC.js\":\"b3c1ad9bef9015ed\",\"/knowledge-medium/chunks/Preview-Cc4kxJ_4.js\":\"e6d8c99f3285b2fb\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CBt0ZcDV.js\":\"f5ce5634c1f33f10\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-Bk0m8ugz.js\":\"592bd52feb1dcd36\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-29tofhsc.js\":\"713b75539d78066b\",\"/knowledge-medium/chunks/react-38ea83fi.js\":\"a88470de5cacb3cd\",\"/knowledge-medium/chunks/react-AfyiWpJO.js\":\"14acc6d65afedf71\",\"/knowledge-medium/chunks/react-BHhcZFel.js\":\"7653e54c0198dee7\",\"/knowledge-medium/chunks/react-Be6O_9iu.js\":\"90d7a58cb6f4286c\",\"/knowledge-medium/chunks/react-C7rns7a-.js\":\"bf70d8e7dd5259ec\",\"/knowledge-medium/chunks/react-DEwdETs9.js\":\"9f686a3d40b03425\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DE53KWId.js\":\"9d7fb32cbb0ebdc6\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CPMzTCuj.js\":\"94364a3b59539054\",\"/knowledge-medium/chunks/react-dom-server.edge.production-n4bapUTg.js\":\"7e6455aa7b5afd09\",\"/knowledge-medium/chunks/react-xqcunHm8.js\":\"dae84d72ccfdd3f2\",\"/knowledge-medium/chunks/server.browser-CkCFXEvO.js\":\"faa6498c8a984153\",\"/knowledge-medium/chunks/textarea-DRkE0egf.js\":\"9e05eb0980fabf30\",\"/knowledge-medium/chunks/ui-CDR7gS3v.js\":\"389627dfbf582ac0\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"fa4d95f7005c45bf\",\"/knowledge-medium/src/appUpdate.js\":\"ab0545df9f7b30ba\",\"/knowledge-medium/src/appVersion.js\":\"31fed67f5b867937\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"e43d65cf2c99ce0f\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"fc6b56e259d0a97f\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"9afba469075b760f\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"c01821c993acddf7\",\"/knowledge-medium/src/components/BlockComponent.js\":\"1479961b9df5446f\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"42fcb14f5e9c9b8b\",\"/knowledge-medium/src/components/BlockEditor.js\":\"b4e6b52f49b29cfc\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"479188cdf53cdb0a\",\"/knowledge-medium/src/components/BlockProperties.js\":\"cdda309bae6a7969\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"55d830e47dd062d9\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"591cf7d108e177c1\",\"/knowledge-medium/src/components/DividerHandle.js\":\"6c709f6f62da1628\",\"/knowledge-medium/src/components/DraftEditor.js\":\"bd9da7e465cc2123\",\"/knowledge-medium/src/components/GutterPill.js\":\"98df3ef9e2f32ac8\",\"/knowledge-medium/src/components/Header.js\":\"5cdebb394b70f65f\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"7ea7601a8798dcad\",\"/knowledge-medium/src/components/Login.js\":\"c7df4107f4182639\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"b70c492958cae5de\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"8e3cd19e86876b59\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"670409378835c725\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1a48767ca94baefb\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"1a81cb076179d78e\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"f8093ee4ebe81d6a\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"1b454e64321d2ed7\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"d04571c591899b12\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"8535b4724923bc1e\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"38dec19fb7fba726\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"668a6b2fcdfd909c\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"476538480f8eb2aa\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"c560ca94a5352126\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"c5d4f06644471161\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"fc0565cdbb1f1245\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"1af70ff04e5548c3\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"bf261fa3fc5cf86b\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"f7d1cd8a12394726\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"b8d606dc36e6ec2b\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"40c13b77a2953adc\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"4989489196dff734\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"bd022837100a8099\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ecd18fd384dc7ca3\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"5a107c45e2a59e46\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"e4668091e7fa8a0f\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"8a6f61477814c308\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"776416f1ebd9cfd4\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"7180ea644ce669a4\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"4cbb535f6dc18fd6\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"f79a127ccb889d50\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"9381be2c66fe558b\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"c4dbc72abf45ae90\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"24d205e4fd566782\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"6435bdbaccf9db53\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"9213bc1053345036\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"b0ff9abc7aa6dfb1\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"7adbc79624f1492c\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"937ca7c4171f264c\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"34267dbb609ac3ad\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"17d17ad92ec23ce3\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"905e4d4612027bbf\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"319f1743dc4f7f68\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"e316b738239b4ace\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"7b290b650c2b848d\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"ac7a10d9505b7550\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"8c2758d77b5032fc\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"527532ea381c24fc\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8b2537d39fa2f44a\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"5d6526333dd41946\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"9f2de0d07ed152d2\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"79d9de980d7c3d26\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"18097c9cc99942ef\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"51d4c3c8a1824f1c\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"ac49dfa9a43fbc1f\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"73b1101ee7dcac9f\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"3b4ddb528ee41e86\",\"/knowledge-medium/src/components/ui/button.js\":\"f79e80ab7565d379\",\"/knowledge-medium/src/components/ui/card.js\":\"af20c03a2708ad7b\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"d278beef2e45a8ac\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"baafbe8130374ecb\",\"/knowledge-medium/src/components/ui/command.js\":\"b31881478d9c708f\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"051db6f9600bc184\",\"/knowledge-medium/src/components/ui/dialog.js\":\"c6a64554cb4e0159\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"ded24cf1988e57c0\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"ef05af4bfc106ddf\",\"/knowledge-medium/src/components/ui/index.js\":\"c56c4c5c5b2548a1\",\"/knowledge-medium/src/components/ui/input.js\":\"eaf284e90c5cd5f4\",\"/knowledge-medium/src/components/ui/kbd.js\":\"2fae8c1c8ac74c62\",\"/knowledge-medium/src/components/ui/label.js\":\"944b5f7392688f0d\",\"/knowledge-medium/src/components/ui/textarea.js\":\"30c856631d42d3e7\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"0165747e8fa0a51b\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"b6e57bd2ad6e3fc4\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"9589cbaea1994c99\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"03d9cae778447a23\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"78c0d019b334636f\",\"/knowledge-medium/src/components/util/error.js\":\"c0ac88dce3e9161c\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"c579e4a2ebeab0f2\",\"/knowledge-medium/src/components/util/suspense.js\":\"87111cce44964ab5\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"54fc75f36414434b\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"c477605e2099e350\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"78d990c0a5b0ea92\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"5de0a51e9ee59f27\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"59693ba177152946\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"5a7f8ddfc6c2abc4\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"5f3775088644e94e\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"02768c1302a67d89\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"175192b8f8383bed\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"4d31d98d6075602c\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"f90329d59df9bb8a\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"c164845b96146d6a\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"398a9c3990f13325\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"92c9fd1fc621eed8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"c15882fd273ee0a0\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"9d332c96ffdd0aa9\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"8e29ba9af39096a3\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"90a8929f48cf5040\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"e0f322ab27a70d4d\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"cb1d163be35cd859\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"446e3352a7ba49e7\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"004823b6a8c6e387\",\"/knowledge-medium/src/context/block.js\":\"c9d1f8f0a9fd775e\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"8d314233600f357a\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"3b670038ac2c49c8\",\"/knowledge-medium/src/context/repo.js\":\"23b71f9ac44cc46d\",\"/knowledge-medium/src/data/aliasClaim.js\":\"f4ea8c5360463604\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"721f8bdfcb840c22\",\"/knowledge-medium/src/data/api/blockData.js\":\"753b9db07f999b01\",\"/knowledge-medium/src/data/api/blockType.js\":\"7c28fb5372c5004a\",\"/knowledge-medium/src/data/api/changeScope.js\":\"3a896dfa69d828b5\",\"/knowledge-medium/src/data/api/codecs.js\":\"6d990391096f26bd\",\"/knowledge-medium/src/data/api/derivedData.js\":\"9831fffd9d643691\",\"/knowledge-medium/src/data/api/errors.js\":\"c22eb4d98c1931de\",\"/knowledge-medium/src/data/api/events.js\":\"19701152ec07350e\",\"/knowledge-medium/src/data/api/handle.js\":\"b650b86d6b8bab7c\",\"/knowledge-medium/src/data/api/index.js\":\"e082d272d44ebcb1\",\"/knowledge-medium/src/data/api/mutator.js\":\"4fcf198f90605563\",\"/knowledge-medium/src/data/api/processor.js\":\"bd8951749e8e7e6f\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"1185f9b5abf05a34\",\"/knowledge-medium/src/data/api/query.js\":\"4c632d42b5f74caf\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"509a492ef0637767\",\"/knowledge-medium/src/data/api/schema.js\":\"b650b86d6b8bab7c\",\"/knowledge-medium/src/data/api/tx.js\":\"b650b86d6b8bab7c\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"1365c78e9893bb15\",\"/knowledge-medium/src/data/api/user.js\":\"3fae3c2d947b857e\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"18709a513beb053a\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"d52bd8509db92e7a\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"40afb267203f23c3\",\"/knowledge-medium/src/data/block.js\":\"f7c9a103e5ee6549\",\"/knowledge-medium/src/data/blockCache.js\":\"fb64b581b35545cc\",\"/knowledge-medium/src/data/blockId.js\":\"ae83c2e23186fa1a\",\"/knowledge-medium/src/data/blockLiveness.js\":\"df65bd0e2080a30a\",\"/knowledge-medium/src/data/blockMerge.js\":\"4492758a054b5e68\",\"/knowledge-medium/src/data/blockSchema.js\":\"78a60194b5516751\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"9ae22715117aefa3\",\"/knowledge-medium/src/data/blockTypes.js\":\"941d0ca261b9408a\",\"/knowledge-medium/src/data/clientContext.js\":\"ee9ae2b61db94d04\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"754549995e9d950d\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"d2ba69d02a2cc16e\",\"/knowledge-medium/src/data/derivedIds.js\":\"9ab4d4f3cbd5e5a7\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"b3b328c7733eab0c\",\"/knowledge-medium/src/data/facetBridge.js\":\"a78f201b7268cd25\",\"/knowledge-medium/src/data/facets.js\":\"cfc5197868e56cd1\",\"/knowledge-medium/src/data/globalState.js\":\"1df22628a1af6085\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"39c6f03a77224f5f\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"96f9a15af9175376\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"a15a69cee0414fc9\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"b16c693934f6ce4c\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"07827e2f9e26d7b2\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"aed49546a51e870d\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"acad926886a95035\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"64e7ff6313842c85\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"8d8135184088e068\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"d158a544b1df3558\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"b31c025571713cda\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"a23429ad466498d2\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"f2732c71b3e21696\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"a24cce4f5dfd34e9\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"fc3f01f88a8d6faa\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"c55c1d5b35cd875c\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"39685dfc6bcd58a4\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"ae98e9bfdd62c3bd\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"ca289e708523f0de\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"55975f00f20423d1\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"1fd3e6c3ebdf3741\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"ab58b1be958397e5\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"a5a0b9b75acfeb45\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"582ada4cd1747a8f\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"551c3aaa636c0aaa\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"c24181779a3ed748\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"515f735818ccdba4\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"692005dfbb65119d\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"ae8c13deb576282e\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"62c11237b55e90da\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"67fecc0611daaaca\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"4060cc7468611725\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"85cb52b6b7df8e78\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"f0eb7cd703cd7e88\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"4c67d5173f3d65e0\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"e6017d8f8b982e02\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"18ac3a27ef5182d9\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"8266c3aa0fb40d29\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"2e1c92f4ce543070\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"efe68d0a33d75eaa\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"f78498e11f8d4aee\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"b7fdfc179aa40241\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"bc4964d181660eeb\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"7ab614b9c218bf88\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"8096a291218ad2d6\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"bcf6b9bb11a57c75\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"b9d2866c1446b537\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"36a4805aa28a39be\",\"/knowledge-medium/src/data/invalidation.js\":\"5cb1d2ec35392563\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"dd2daef6694085a7\",\"/knowledge-medium/src/data/kernelPage.js\":\"b4d3fc2a4bd51408\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"6f67cea71215ee54\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"12f78acea04d782e\",\"/knowledge-medium/src/data/localDbStorage.js\":\"467bde82c7566a2a\",\"/knowledge-medium/src/data/localDbVfs.js\":\"2465028a604f52b4\",\"/knowledge-medium/src/data/localSchema.js\":\"007247639ce12a7c\",\"/knowledge-medium/src/data/maintenance.js\":\"cb3b6bc0957bb2c6\",\"/knowledge-medium/src/data/mergeProperties.js\":\"18258ee437f9a2c2\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"79a74d5b1760ee23\",\"/knowledge-medium/src/data/migrationsPage.js\":\"679a553af79c7314\",\"/knowledge-medium/src/data/mutators.js\":\"b0e79b318026db30\",\"/knowledge-medium/src/data/orderKey.js\":\"fecba4a1098dcea9\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"2f9563f6d454339d\",\"/knowledge-medium/src/data/outlineSurface.js\":\"c4fd5ef9c042b01f\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"cf3961052e5e14c8\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"180cbbbf68dae750\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"8db08e0949c975c0\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"f75a263b9aae511f\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"b2e9b26b32654fa1\",\"/knowledge-medium/src/data/properties.js\":\"3041a94dac01262d\",\"/knowledge-medium/src/data/propertiesPage.js\":\"539c64894a3f4a39\",\"/knowledge-medium/src/data/propertyChildren.js\":\"4bb12a86cfe38429\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"f2156464f96b7325\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"3bbee077f2e3cffd\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"a75aa5640df2c40c\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"2e040bf1a76bc307\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"d0ee79f362dd1b8a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"d122359ba2ec182c\",\"/knowledge-medium/src/data/propertySeeds.js\":\"96ea9b9fab41c6af\",\"/knowledge-medium/src/data/recentsPage.js\":\"44b0cedc0e11d795\",\"/knowledge-medium/src/data/referenceBlock.js\":\"4ed2ad4e79fe8e98\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"13828fc62c2e21a3\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"bee085d26504c96a\",\"/knowledge-medium/src/data/repo.js\":\"48f68870730a5ad8\",\"/knowledge-medium/src/data/repoProvider.js\":\"f41640f063733942\",\"/knowledge-medium/src/data/rowProperty.js\":\"8e91ae1d009a7ccd\",\"/knowledge-medium/src/data/searchFilter.js\":\"5ecf1636d99351ac\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"9a7854df49ca93cf\",\"/knowledge-medium/src/data/stateBlocks.js\":\"3b29f43bf83a07da\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"39bfe32c1022b47d\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"e33983bee10d7bdc\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"6860b92ba64dcd85\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"d2ede5071455004c\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"cf79fe44d9284768\",\"/knowledge-medium/src/data/targets.js\":\"34a84c8a3b6ef6d6\",\"/knowledge-medium/src/data/typeColors.js\":\"a0a758a2566d8788\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"094c8c4a92329bad\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"36c6487a210e7bae\",\"/knowledge-medium/src/data/typeExtraction.js\":\"d5ecaada48ca2c4c\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"cf96365a413280eb\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"c7600eb42d40c939\",\"/knowledge-medium/src/data/typeSeeds.js\":\"8a3a70e698e89e51\",\"/knowledge-medium/src/data/typeTagger.js\":\"adf5e9a932dcb529\",\"/knowledge-medium/src/data/typedRecords.js\":\"c6b293b571d0b20b\",\"/knowledge-medium/src/data/typesPage.js\":\"ccdd327bc3f03dfc\",\"/knowledge-medium/src/data/userPrefs.js\":\"613d136c57be037f\",\"/knowledge-medium/src/data/userSchemasService.js\":\"de5bcec91a340f82\",\"/knowledge-medium/src/data/userTypesService.js\":\"4415a53f397cf4c8\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"f47006e0aaadd485\",\"/knowledge-medium/src/data/visibleChildren.js\":\"c5833c7107dc14b9\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"4ef44c3dd5f10055\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"a06b30fe2be3f453\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"90523cafd31933fb\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"c17806a0b8dff000\",\"/knowledge-medium/src/data/workspaces.js\":\"6d388002eb92c034\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"f53cd8ea21dd818b\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"5d26a0c7675d0831\",\"/knowledge-medium/src/editor/atTrigger.js\":\"3d08a82f6cda6141\",\"/knowledge-medium/src/editor/autocomplete.js\":\"210d5c39ca167ecd\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"2c803291f4e1e3fe\",\"/knowledge-medium/src/editor/contentFlush.js\":\"0b9ea2c6faed1898\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"ca7e7e0cadcfd035\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"c8c0d88cb4be065d\",\"/knowledge-medium/src/editor/insertImage.js\":\"bd9590441161fda2\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"f7cb63181f53154d\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"117298977c569cfc\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"03380cbc3391bce5\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"c3001c28ea0a5e02\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"b3059d3652d5c7ab\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"48b55b1024ae9a85\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"219cc04059ea0b95\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"179aea2dfd8251e3\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"b3bcbf6cc373fc2d\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"44a43c9c185f028b\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"d210bd866c2b9269\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"149413e61fd905f2\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"7483a001b05fc6d0\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"b5aa271c198aac8e\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"2b96a70d22819f96\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"2c8ec00f61a6181d\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"027880e72a0210f7\",\"/knowledge-medium/src/extensions/core.js\":\"7ebba114a9beaca0\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"8722250fb36ebf91\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"67aac1b9b1a704b7\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"109a8a9df122cf4b\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"ba0be35fe0453d89\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"5c6595f452a4cc9a\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"d903b10fdd03f83f\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"c5fb1b94455a7902\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"fac29df9c62480e0\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"6cfd1a63ab820083\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"00230d2401f7a965\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"fbb570c8abdd567b\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"21bfc21a77fbefb1\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"3d14012a0c18bec3\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"048b1881312698dc\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"9011f2cd265c646b\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"defd59bf13feea1c\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"b787f835b05f8210\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"aeec6624e1499eb4\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"98f0694d9f0b2788\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"762f9a70f7eb8521\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"124fd15c679c7076\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"6bd9038fce26e2da\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"35eb4d4d98f71675\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"974108e705296227\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"c2964b5dc304b96d\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"3e5b2dccfd96ae84\",\"/knowledge-medium/src/facets/facet.js\":\"6e2e4b8b453a13a3\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"51fd501611f4df17\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"813bc38170cafb8e\",\"/knowledge-medium/src/facets/togglable.js\":\"6280c822ab7c22b8\",\"/knowledge-medium/src/facets/variantFacet.js\":\"5f4591d4b605b5e9\",\"/knowledge-medium/src/facets/verbFacet.js\":\"e3e88a6fdb296d62\",\"/knowledge-medium/src/hooks/block.js\":\"e067c32f809783d7\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"1974b4dbe3e98b9c\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"052c34f2f7cac6ba\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"89c8b3ecdff5a88b\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"d5e0fc1734488055\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"44f339304a7cc23b\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"03d302d6bb60dfc6\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"a223375e35d71656\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"ad3b64ddba0c709a\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"51b1682096bfe683\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"264059ad8f1315fb\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"9e36a705768315de\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"355e4eae6cd0e785\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"775a1f9fe11b6e66\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"c0def84dacafcb93\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"26e723f72b5399a3\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"2d34feb971d004c9\",\"/knowledge-medium/src/lib/utils.js\":\"7f869554f67208cf\",\"/knowledge-medium/src/main.js\":\"b758a26b62ab1cf8\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"d74f73c4857a731b\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"e7688fde3cccc98f\",\"/knowledge-medium/src/markdown/context.js\":\"b3f059bfb0bbca24\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"270bfdec21ea8bc1\",\"/knowledge-medium/src/markdown/extensions.js\":\"631c0c48c05dea26\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"f4ec38eae174550d\",\"/knowledge-medium/src/minimal-editor.js\":\"40d3e2aa7d5428bb\",\"/knowledge-medium/src/paste/armedCut.js\":\"4393cebfb030980f\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"ea173562e0be5ffc\",\"/knowledge-medium/src/paste/clipboard.js\":\"f4b39e8bd82cf873\",\"/knowledge-medium/src/paste/decision.js\":\"126d07e128e5b2c6\",\"/knowledge-medium/src/paste/operations.js\":\"49a344c914d8d388\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"36ecca1641f631b9\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"4f2d7f6b1b5cd4a1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"641c29e39dfc9907\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"733e950394e82b5e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"7457295c54c51b70\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d1204ff04698b1a3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"8a5ace369069bd0a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7e5dab2885242faf\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"c5e8b42b8d4ad5f0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6b377b26d7f2cdd7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"acd9cdf0ffe8615e\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"76cf97569cad422d\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4a2fdd6602792c19\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"9ba422869f6c006c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"dacb0f7ebd334394\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"5567975c0bb039c6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"4350d0a9097ed600\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c302d75628573b04\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"0671e7c7d4ddd5fb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"f3c681d359c339cd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"201fcad3cfe06012\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"a456332b20f5a413\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"89e98e35c09ce0b7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"9dc2786a9593e0f2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"97bc85ca09c13113\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"227f813bfbdb3d8c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"4edde44445a94701\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"085db5f5cd812b73\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"a1d13a5952c62dc2\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"7e51a4c40b589a39\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"e77da70dbb6f7205\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"56c18aee1bc14757\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"b55bd219ad4fe229\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"13d2aaa7be4eaead\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"b20b0b1c44d25291\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"96f8aa86c3c8dca3\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"1108484e9c603438\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"656999dce462a02a\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"ffd38c87a8e7e612\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"3c14065ff87277ce\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"7ffc5a979c624e8e\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"d7fac5bbd5866866\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"fe1b11270ef27822\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8de3f6f4ba117079\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"f8ad0a0d1e1b31b9\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"a659477833364fa6\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"0ed108e059fbca8d\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"f5657d5bc253e5cb\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"cdd4007dfe91b31f\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"12de55d02d1ef2bd\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"c50e95036956342a\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"67c31d355c237f15\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"622cee0ebd1acf14\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"eca76797b643f9c2\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"73a5bf5ce4ca271a\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"763b85ae36af6f82\",\"/knowledge-medium/src/plugins/alias/index.js\":\"d7566aed6591ca78\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"dfcb48abef90ce80\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"25b41d55ae2677b2\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"3c8533d2ae456037\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"1070d6441d9d39f7\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"3543c9ec3a42047f\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"2b53003652d087aa\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"7b2cb5fe4f6b3c1d\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"2829c4329a387cd6\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"4c590434352948f9\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"72af79e49876f260\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"2e5e85daf5584d0d\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"8a92b656a7bb7d01\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"8c4e47344c29c9fa\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"231b359416ab5b92\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"245757571ad6f064\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"8afd7e046659c2e6\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"99a48542078cc7f9\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"fa06dddd56277078\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"30c91d2f93064a61\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"63ab8842f80b778e\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"788f990cd9d740ca\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"7e07f3ffa4b74c6d\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"4c42c28ba54e688d\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"373643e0cf0f1c3c\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"a4218df62c8cc1fa\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"c8ab6ebbc962698a\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"f221be9ab783b532\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"ca277aeb482c7d61\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"129c314e57b503bc\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"63addcd341ba17d7\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"3154497cea133b66\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"332586d92b7fb3a5\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"40c571b265808351\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"223846cf0645b54b\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"3aa5e0c117d072e9\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"31f6fb7319ce35fc\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"4de2845dc9d2a2e3\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"2be240677673d791\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"a9cec689ebac2400\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"a81824de049d7727\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"d87bb7f94bd2cba0\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"109c27fb8877c09f\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"27e6313bfc33b9f2\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"61508b6bff300c7b\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"283f3b14b6ac18ec\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"0a72f5ac7f1a9d4b\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"dc4fce4b84f89258\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c47ade0e1858de25\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"1338fc07278848a9\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c344bf94ec2efe58\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"2d483695c65c0119\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"475365b3640c53dc\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"c96fd57a1ccc1ccb\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"164b2d12c1c3f416\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"38e207ac83aaeded\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"658e6e80518eaa99\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"ac5e7346d489c597\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"6f4a76ac43fafce7\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"73b8d28d2b86913f\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"a22d6ffe022bcef1\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"6925d3f28c48fcc6\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"f0597f574578e323\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"81b611a7e502a062\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"13e3552bce10f000\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"54608f852f87f9c7\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"4dce143346717882\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"e7ea99f132493d79\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"118ae155cec35806\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"d2172dd15587b5bd\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"912de73a477c4ad9\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"a1e3219e4fcf4092\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"f9d0702ab6fe64e2\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"042f097fe8c601a5\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"a3b744eef0f45923\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"910507b4896b0b58\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"cd02a1151ec4c35c\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"888f901362579bf9\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"c7a07a23bc8f6923\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"ae388b056c3ae17a\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"c53947b8a1704d01\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f15a44443c45e5f3\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b76c3a38dd640759\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"605326a46c17bc2c\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"5df1bf8659a9dbfd\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"910b901207499ecd\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"278ad7a1632c2e31\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"748bb7849e4e6b4c\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"3063f8214526354d\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"423b7b0c01cee9e4\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"73450262f347f854\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"c6a139a15b6fda5b\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"89c77a99272de9f3\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"71f2bdcf450bd5ab\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"312f60e0e3065979\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"fee1d83cd20b3e44\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1b4e1a8bc597b9d0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"b60ea7344b6784c8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"63cdd0b066fdc960\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6b3624e9838efd68\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"d3756ad802669aab\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f556642f0f145ceb\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"bc286b1afe7c4f7a\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"a1228575087e09b0\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"df6ffb1e43b9aa5e\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"947ecb8874e5128d\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"2afe0c002f2f9556\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"4fc7604d61b3bf67\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"4eb518bcbb19a698\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"e9c0ee14af417855\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"0459acc22a06b9ca\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"2805e80a8cde56ea\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"97bba291d632057c\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"525387f3c763e8ba\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"b3889f0351edce0b\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"628f86653e21d09c\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"eaf5ece0803cb3c1\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"7b134db379ee58eb\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"d7ac989bb6653758\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"ec40c969c73c63f3\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"919ac4cfbe8b89f4\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"ddcead3597b68006\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"925b0d67378df2fc\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"f65afe5ff2a401b4\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"86b72c460922065d\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"26c1f52c4d238462\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"4491932300e9b4aa\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"d665cfb80c114533\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"2fb4d3de6e922402\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"69527f5b40f5f83b\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"a20126ac58d92402\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"483329ac9c0355be\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"4b90091a831acacb\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d5d5295399ec81a1\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f21865f75e0b972c\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3d98aa54cdfc87d8\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"64edf917ce4e9b9c\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"1c273e34a0dad538\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"99fcd725deb5f47f\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"d28b04876e3e904a\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"20e05c497d501160\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"1c034cc0a2435df8\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"48b04873120cf3fa\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"c702e2805cfb3c35\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"3196e76058a95f4a\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"db21d9adfa547882\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"aa88b20090aff965\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"eed4d8291e60a299\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"e1aadb99fe3a79fe\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"aeb3f8e46943754e\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"8d7205ddd8749e99\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"d8f9c995ccb99cd1\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"72f4a4b2af79573b\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"9c6600173414cdcb\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"619926f11b36b628\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"9c0ebdaf02ef99a9\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"f3cded22305820c5\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"d9bd6056cdccab8c\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"9a53ba40db738c89\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"ebeccec66efc4c6b\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"4b57ba4f02b1c3c2\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"160baddb50ff4aac\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"c5ebbe4e35227d13\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"f3c6fdcdea691e09\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"eba156e081a752fc\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"0db2fd59c00a31c6\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"ad075c6fa6d994aa\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"629c603d5ea5a712\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"1eefa0001e919079\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"1b0e6bcf2687eec2\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"89063f9719c3c407\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b37e59418f6a582d\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"74f909ec39ce9de5\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"85dfef4bf4c54b64\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b04a0b6bbc625cb4\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"d668c4387be78725\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"ed3d43dd1af63ab0\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"e85935b6911b29d2\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"10c4d3095ef1a76f\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e429d2b22823c6e2\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"bbb506a9abe1596e\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"c132ed3225e9850b\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"0fa7a3051fb32065\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"9f777e9d9b975d60\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"c8ca471ae427d326\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"9f7a469f9cadc00c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"ea3e71c2dc262477\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"94d0e96a992f0d1f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e93d5a0acd96e95a\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"6da4022d8bf03aa5\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"64eb287a382d4179\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"f2eb9c348b498d09\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"2126b29a4b9ebceb\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"8154a568ec488f17\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"93a4bfcd00f4338b\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"cf4ab3a4e63aa465\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"bae92847898ef849\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"d0234b0fcfb3be8e\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"64da1bb9a309d6e7\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"1d864961c74b937e\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"6f67ef4b1aa66bc6\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b79cc32a52601a93\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"1ed4b935e2702e78\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"e37690c7e5a5320e\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"f4dd1ae92a15195e\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"e59a164393f8e15b\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"49d0d14e155b9712\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"3452c9c442abc0b0\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f11d2091f2c48726\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"29116e365620aabf\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"4e55bdae3e9f9657\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"188a6c2e81a5182d\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"45ce40b64af37c45\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"c8ae00766eb2bbd7\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"597c95c22d483319\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"8f09fc3b71bd288d\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0b7e4edb090201b8\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"28c6f97c382e9575\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"92e8c476d208fcf9\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"f81c2761f27e4d0c\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"853d7c25777802a1\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"ba6b534598648d85\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"5702ed235136cfe3\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"56bcdfb12341d861\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"138f4270bb96b954\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"4d3da09d114015e5\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"b4a56ea949ede9d2\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"a7fa53640708822c\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"c9593920d8c530ac\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"fe5fdbfaf8b56f91\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"1787e69b0a9b6cfc\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"5a9b9a2df2d3822c\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"e2d7a3a1eb5d8dc0\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"97dac5957998afbd\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"bf55d8fa992cff57\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"ccd19e0cf7110fe0\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9639ae86a64bf12a\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a6125b74a5009d91\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"6e97b5ec0e943c53\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"6bc70c89214effd8\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"93d6a84518198a66\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"4dbc85d9de814f14\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"3fc1f484842367eb\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"194ab09b3d7e6ca1\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"67829f57d0675d0f\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"6e5ea5538965918b\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"967a431afcdc0584\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"6fb52d215386f807\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"9109ceb292845666\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"8dda497e78dd3ddf\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"72cc737dc733c27f\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"4744467665a8db99\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"c56b646bdf7546b5\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"b5813eca4bde6f28\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"559c1db46086f8fb\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"57c1907969040e06\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"6daf613755ada11f\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"39a258d5426cace4\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"bc56a04d1952a0ef\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"9b0a89ba42467b10\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"2ebbba92ed1473f7\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"71f0bd48793a5c28\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"9f7739167e66b04c\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"8d81f8502b6b0c03\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"3a5ce20365a58f6d\",\"/knowledge-medium/src/plugins/geo/index.js\":\"edadcb25d25366e7\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"22b36d8176218d1f\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"b7bc382d96afa33f\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"ca5c11c1f05797a2\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"6362fb8d686efc33\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"491748b4867b877e\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"00683c8eab6c31aa\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"a40286275538d357\",\"/knowledge-medium/src/plugins/geo/query.js\":\"b23f8ff12379634c\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"9181e4866868c496\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c01bece43c3d2105\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e3f9cd3fd554d835\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9c8c5c7fe15f6b71\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"500cc75601a40f1e\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"d6f8191e68ec1fc8\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"37204c73606970de\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"9fc3ae89a220046f\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"e2017abfd44d8bbf\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"de9addc0878c17e4\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"10e6389e21e7d220\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"a868fe508ef942ae\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"52fea37b093bc614\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c226bd9b556041e2\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"e32b54fef34999c4\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"68ef77234be9e449\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"baf69799cb20eee6\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"505d9b1412333df2\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"513356f51b25d4f5\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"69ad0351a6d0ae4f\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"ee2b564959e550cd\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"a6ea59838c2d224b\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"995f4e68019502a1\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"b2730b51237083e5\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"47c99d9bfc5fb08e\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"e5062aa044ab4a26\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"b973314cdeb150af\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"a2478aaca123a2a9\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"906ada1db2f4b599\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"ea820537eae955cc\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"2e4dc59b7337c21e\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"970962da855b5350\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"9522fd33dd46b498\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"aa426a088eac5785\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f27f76135dc424e3\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"25a07084e617f29c\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"2e70c1afffcbf50b\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"f6389b5e47c79a75\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"f0fa3fb03637ef0f\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"ee4a21a67aacfc65\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"9bda561bdfa032ef\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"eb991470c8f3c3ce\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4ce3ef6e96dc3fb0\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"0f98326847f497a3\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"03ead3d14410890c\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"d4bfb96616b540d6\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"2cb46e48253629fa\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"e948c881159bc160\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"fb5302f1ab525dce\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"8464574321689884\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"1894960744a1c0cc\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"7d0b0c086792cd83\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"0fd1aaf58fba3704\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"cf7242c3005fbd87\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"77fe7574056e0c1f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"df9aedc7c13cb5d6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"98f0bc95c88abf98\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"52db426c6c7d881b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"d0909645c1ac67b9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"9fac9d0438e7eeff\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"da8f58c03f6f1b3e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"12311e8d2edbf7bf\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"3bb93114c9dd09b1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"c0007743ce82f514\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a0fc9b70c5e832dd\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2bf8848871ffc56c\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"58761ca686caead3\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"1105deab779a142d\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"37d7dc6a13c87b78\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"5a5829ee12899133\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"ca82d5c591467276\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"7f6e3bb000e50f71\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"a4df68d0254ef47e\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"dc1758e0d59b0d67\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"35b0122eb47b826b\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"8ca1f50e82961b5e\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"9134ce06a5df2a02\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"4296567966aa5eab\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"967bc8ee9cb9ad63\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"7e44fe85f988e3f0\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a3ff33051d2cc984\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"c51ef585d002bb86\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"677b63feee837b71\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"332e687f5ea28aae\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"821c9ffd17fe9acd\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"b45bc41b257060c1\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"64138b5b19f3af23\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"32a7eb2334ecf3eb\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"580829e6f69346ce\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"bf074f8541a53bc3\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"125b4714a289b90c\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"5b9a58b393aa3bd7\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"8d777c1f56b0f862\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"65e0d9d21a3d81d3\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"93985504bce1f770\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"6a4555571ded8af8\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"b7204c5e1b1ec4fb\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"652a15f3c54ef6bd\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"3f4c8fd2f83c9970\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"f0229642cb48b5b8\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"1de41b44f60fa8be\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"848b9f31c43b07bf\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"13873e0ebd405538\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"f870b07d1c812601\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"87c65264ddb7e156\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"e0eb5126695afb0a\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"2d84c45b24b2d658\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"3b6838a4d2629a55\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"f8f43de9cd82fddf\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"5751179d5c64deb5\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"b4d8c9559bfc635a\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"ef6bf061bccf49bd\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"105344df117a862e\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"ad73b0cadb60f37c\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"e08aa4e0c4cd25f2\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"c5b5e2365b45cb90\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"5e5c46794bd01f83\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"160413df368a8a88\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"3362747fbeff8bb6\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"d4e24dba9ac6b8f5\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"33f7eca214f04aae\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"f02614b0193d079c\",\"/knowledge-medium/src/plugins/recents/index.js\":\"ec6f64a46fc32604\",\"/knowledge-medium/src/plugins/recents/target.js\":\"cc13b7bf25f24cff\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"e2829116ab90560f\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"43dea4a2d3dfcd2e\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"76ac1168d94d78ab\",\"/knowledge-medium/src/plugins/references/index.js\":\"88bfc18ad3628ee1\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b4e5a8426597c81e\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"3bb6b0b099a2843a\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"deb0dff4bdcb337d\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"af5e77615568a7f1\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"352d59b4042c0a5a\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"93beddba9511959d\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"42ee668fea543522\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"807a3788f3e44a3f\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5503208eb88cbaca\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"4a64f9d248012844\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"64b8fd66cea421df\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5441a528a87a8592\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"664d3db233a9b3dc\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"b643dfff88bc1482\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"9663887171c2569c\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"a50b17477344833d\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"8ce2b35b8ebd8474\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"f9cb2eb5a6e66f22\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"a39dd805e23d15c5\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"b33af68e586e0cf8\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"fbf179dbd5401200\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"06de9bfb1e9d47b3\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"5c6c1b7556dc6c3f\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"e2e23045f7dc5eb5\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"e17daf6e4e6cadfc\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"fec44e2696da5434\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"38f715d4fc67d705\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"afa0b2a8bc09a414\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"52a5256a6e383c7c\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"b96185019ba3d5aa\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"b50c9e74282f6b7a\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"2721963840a9bdd9\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"128e64e0b7f84d21\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"e8e1df6d2e4b29a7\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"c89e1fddee9162be\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"6cb9b57672f73456\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"5734823fc5048732\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"50fc9b2acacdb692\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"2ffc2d6212aab768\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"8b7ab8f54a7461e7\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"c176ec5efedb3cca\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"6922870eaf3b4b4b\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"d331173d1db7f57a\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"13fe7fef8934714f\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"7073afc7b3fdb6be\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"daeaed44820b849b\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e438e35d3afddc17\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"8908c94defcf4c1d\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"f2caf44584d47b88\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"03eca80040b033f7\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"50ffb19e08bbdeeb\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"850514c85cee0950\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"2a077898efd193c5\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"bbf4523010f9bd50\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"925f5fa3b1646406\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"73a29f75f1c35841\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"ff43f51405fd4da6\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"ee1a72460636d4ed\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"9394c79dabb2a25a\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e9821d58c56d67b3\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"2ab5002f2166fcfd\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"c87b3d851077844c\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"d5af3496cce0a442\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"118c66291368f0d2\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"51657ecb9cf00285\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"8429d96706eeecbf\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"845ebdd53fa00004\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"7743d18c43a2fd7c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"1217ced8533b17a1\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"09fb21f4c22da0dd\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"67207aeddcdc0098\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"1312161aad1cbf9b\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"4b0b0adfc57a0109\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1224b2eda786286a\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"e972eb1c573383ca\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"19e21860a14ced3e\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"234a0d9087837533\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"15c1f8c53de7c885\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"55018e28e0cee5fe\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"20b56aebb9bceb74\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"bb842263bc8f0ce9\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"ba1c9b042b6f1b4c\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"28e6c8ec9bfc0ee3\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"aeaa1d21aacc374d\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"6622ab723f23caf2\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"89c41c4ad04fb87b\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"99a4d885f0e72e7a\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"e473bf2eccae0f97\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"1a94b84a463e05d8\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"65a14c481997872f\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"cb59f69fab12813e\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"3e0c9d0f2068bbe9\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"6c314661a3968d96\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"9127c775c7a79cc2\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"20463fffa9264612\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"a8743c29d386a02b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"220c00564065eb07\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"255f03de7bc63e09\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"fbe1c3b556582047\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"bc35be30dfb5fa86\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"d5442e929a6880f2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"48026af1b54de288\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0c8897b8fb893bed\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"ed11404f3c8911e5\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"31d9167ee00c00e1\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"2bc6f15dcea6a602\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"7eca519db01212ad\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"6774db65b0d17889\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"6928253f7cebc95d\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"7d804bc1dc45460d\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"f4912a4d9500f7cf\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"a2b2d91285f2b857\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"8fb4779957572a53\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"f4ab6c7bd2b18d8b\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"acce54009a355f7a\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"fb5d92e0c8f840bd\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"df45b04c262473bc\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"b1d33a7b448a9835\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"bca043726f74c21b\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"0043b02d9c1c0adb\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"5d14e6910813d0b8\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"6ee414d9904c1277\",\"/knowledge-medium/src/plugins/tables/index.js\":\"bd8ebb4489269c18\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"fec193ebb9803bc6\",\"/knowledge-medium/src/plugins/tables/model.js\":\"a4f59f1012bd825a\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"21f633e7fd852d95\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"6ddf071ace81c375\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"3ea290e72d6bbdf8\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"f4d9c54cd4b81dc1\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"80af519e217dfd5b\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"bb96231ec567886b\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"35b8bdef0bcb2c3c\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"7c4b0d58ae668a25\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"ba20669615ccce6e\",\"/knowledge-medium/src/plugins/todo/index.js\":\"b9898a5bca083438\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"6a57965a99d25715\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"656fb3a6887991cd\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"556cba9eb815c68c\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"190cffa8675371c5\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"e7f80cdd2144674e\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"9214ae262a2c85d3\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"e330704384a41e5b\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"505a39953ae0369c\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"61efd7e75ab898f3\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"1a222212720c03f2\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"386e86a12909811c\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"d37ee642b185c5a9\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"132118ea83d0455f\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"694042a9266ee5ad\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"f0ddb06549092751\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"61f195a05f9c8280\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"e7a6b226153fed37\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"2fa2230b3a8a26ca\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"c861c99b343ae844\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"d6da8364ca22fa6b\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"1ab3675729b5b707\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"9367cd0d73d47d20\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"01f76194549bdac2\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"ac6115e544388bb6\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"a2779d60622da78e\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"3005a8bfe29f23dc\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"bd0976cefc62322a\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"98563b968c0ea798\",\"/knowledge-medium/src/registerServiceWorker.js\":\"cc205e52c8da3267\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"fb0338667ef251e8\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"9f43d134be1d2d50\",\"/knowledge-medium/src/services/authStorage.js\":\"9ee9e2707988a3d7\",\"/knowledge-medium/src/services/powersync.js\":\"b2ab8d2accce7072\",\"/knowledge-medium/src/services/supabase.js\":\"7d9efd45d019706c\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"de1cd05efdfc864f\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"f6a87c5386b573cc\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"ecfc78e36a0e1449\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"926a6cffa74e2e71\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"2d871b224943568d\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"00a2d9c8484b2f4f\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"00f00903dd4c852d\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"e2fb736d5dae928e\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"518a50935910b4ff\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"025553e1fabcc7f2\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"d5795641efe3e0ea\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"95e9b964ed30b9e5\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"a270ba0165acf5f6\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"faef3ebb873ec616\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"1f3d073b575664ba\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"bf4cf6acd896d2c9\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"49ee38378767b8e5\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"6040e9f8e97fbc26\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"05f13eec0d5a93d4\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"88d6ece8eebfc49c\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"e181ec9b31efa5a7\",\"/knowledge-medium/src/shortcuts/types.js\":\"e91ab8d6652fcca0\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"dc0340eeb02c3d94\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"a82704d1860ba04e\",\"/knowledge-medium/src/shortcuts/utils.js\":\"df84d57f5b09c3a2\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"6f6b1d7a5044ffc2\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"9dc1f92e02da89d8\",\"/knowledge-medium/src/sync/byteTransform.js\":\"0979836c42b0486f\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"6eaf83cb1a9577cf\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"4f1bc0b94a967e95\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"59147ab99b65586d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"d4e39adaf153c0c5\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"f20021aa15954116\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"25914ea53f65dd68\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"a5135a12368f9844\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"318ce58487b25b69\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"d0f16f197675fc66\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"147c2998d0310787\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"812ccad46de8059b\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"3c63935f6f375a7a\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"f43f519ce561b448\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"dfa364aff9cee50e\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"baf25e8a02cfdc1e\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"c484f99b46e5bd6f\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"6cd15f645604ce10\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"313fadfdd9d882ec\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"d99b82ef9a50c640\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"a94ca00d4fab3e61\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"5e590af73703ff26\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"8ad4efa0dbafb3c3\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"a17c53f5444f4012\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"3e2ac8e9f8b24935\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"ff1bb614d9b515ed\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"e029a0d2d0bbd74f\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"116adab06998f16b\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"2700c4844711752b\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"1939625a35211e5b\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"fe3923a052abea38\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"0a7abf7a55a1cdf5\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"b8aeb1610fac99d4\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"afa4cac7b254a59a\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"247d1f538ff90b09\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"995853a225b076eb\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"90dafbd2b41cf026\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e270bde7fd49559c\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"2efa36b90109eb6a\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e67ecf303b9b7622\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"930a89540d44a626\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"5227bedb1f2f974e\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"dc005d008d26b3dd\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"62b33e0ccf7abc7a\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"0768a5f4295a2923\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"844f2711cbc52241\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"debdbbbfebe2f99b\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"80f2d939f3115c17\",\"/knowledge-medium/src/sync/transform.js\":\"e512f05eb4c9bde3\",\"/knowledge-medium/src/themeBootDefaults.js\":\"322e6318e2ffc934\",\"/knowledge-medium/src/types.js\":\"6607fae8fedae9fd\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"0670a175ac9cb363\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"58f0418519d9355d\",\"/knowledge-medium/src/utils/array.js\":\"bacd54f9583743ba\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"293c697ed97d9d23\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"2b3e8a2c94df0a8c\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"7d5d3e0317bff1fa\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"af324e73ee67c95d\",\"/knowledge-medium/src/utils/callbackSet.js\":\"d6c14815bd4f7f36\",\"/knowledge-medium/src/utils/clientId.js\":\"d5768ec6597ad86d\",\"/knowledge-medium/src/utils/codemirror.js\":\"1d81fdbc1855af38\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"23890187d470f586\",\"/knowledge-medium/src/utils/copy.js\":\"a080ec07a59b6b9c\",\"/knowledge-medium/src/utils/dailyPage.js\":\"f283bed841cfcf5d\",\"/knowledge-medium/src/utils/dbForensics.js\":\"c795783ee4f7175a\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"33878335892b997c\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"99d3fc0d0dea9156\",\"/knowledge-medium/src/utils/dialogs.js\":\"3c353f1078efce5c\",\"/knowledge-medium/src/utils/dom.js\":\"7b3eb4f338fa8ff6\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"e6c9e928c0a42657\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"2d0b955afc586033\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"99a9d06cc920d7bc\",\"/knowledge-medium/src/utils/flipSlide.js\":\"f5de00c11cd5ec2d\",\"/knowledge-medium/src/utils/fnv1a.js\":\"8cfc2ded0bc2ee60\",\"/knowledge-medium/src/utils/formatBytes.js\":\"eaa8be8144e1ba1a\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"f05fe0087226c59b\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"9f67decbceb2e80b\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"4c61a8f5534da998\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"d9c22f898bc907bb\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"59384072149c21d6\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"8b0e2eebb8184930\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"9bf2b5fcacc0cce1\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"8f297986caab65fb\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"9b9a07b9641e2f1c\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"1a8c9af98c86ef04\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"ce5f44f6afb5d6b3\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"95eb80cd210a5103\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"63bc3b300ee7617f\",\"/knowledge-medium/src/utils/markdownParser.js\":\"77f5d48587ce0d77\",\"/knowledge-medium/src/utils/memoize.js\":\"21e5d7315f1b0d3b\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"e2517d2d0c3d150a\",\"/knowledge-medium/src/utils/nameList.js\":\"85c6a68716ca934d\",\"/knowledge-medium/src/utils/navigation.js\":\"d5dae4afbf29e211\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"62bae2d02269023e\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"12548e319b506438\",\"/knowledge-medium/src/utils/panelClearance.js\":\"99ba69bd60930681\",\"/knowledge-medium/src/utils/panelHistory.js\":\"dfe2ad86a94bd01d\",\"/knowledge-medium/src/utils/panelLanes.js\":\"4aafe7e1d696154f\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"724c2c98857d6578\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"a6565d025eaadd4f\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"4671b8107463f67e\",\"/knowledge-medium/src/utils/platform.js\":\"0ad6a9058bb67c54\",\"/knowledge-medium/src/utils/pluralize.js\":\"29bd8749c670261b\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"d90c8e32def3a0f2\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"ce4f968756324906\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"ef4d9048e77c7ab6\",\"/knowledge-medium/src/utils/react.js\":\"10ae0b8453cef0ac\",\"/knowledge-medium/src/utils/relativeDate.js\":\"57b8ef773b8bdcd7\",\"/knowledge-medium/src/utils/relativeTime.js\":\"b9b0094250585eff\",\"/knowledge-medium/src/utils/renderScope.js\":\"06b0326ddfb0172e\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"f088a0bc9291c777\",\"/knowledge-medium/src/utils/routing.js\":\"167ddcba61fedab8\",\"/knowledge-medium/src/utils/safeMode.js\":\"7b9851bfc09a130d\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"13ffc84f2a6f3d90\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"e93a0c1b25adfe9d\",\"/knowledge-medium/src/utils/selection.js\":\"085bf9bd8a2882af\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"2e35b6e81ddf61f1\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"1d7d9b59864a5ecb\",\"/knowledge-medium/src/utils/state.js\":\"35256fbd5f09c0d7\",\"/knowledge-medium/src/utils/string.js\":\"3c034bac2db87ea5\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"cdbd55dfdc604947\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"059e358ced800021\",\"/knowledge-medium/src/utils/toast.js\":\"7cfaee741fcccabb\",\"/knowledge-medium/src/utils/toggleStore.js\":\"d400ed529d1d91c3\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"b0a57d005f53a54b\",\"/knowledge-medium/src/utils/userActivity.js\":\"d4b5ca0e12ca8a86\",\"/knowledge-medium/src/utils/viewTransition.js\":\"0702b72573bea32a\",\"/knowledge-medium/src/utils/viewport.js\":\"6d23d0e4a4be0dd8\",\"/knowledge-medium/src/utils/webLock.js\":\"da37a41cde3bbe45\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"f879a684e1ac4426\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"3f0810f002f75c29\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"2c873623d4dd9417\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"c6f6189a462e44a9\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"7da372a67363ad1c\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"1db0d77973121766\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"4757f1a618a79400\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"34d386deb8d0e7d6\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"9d683cdd2dc90a03\",\"/knowledge-medium/src/vendor/react-dom.js\":\"519e12c57f6520e9\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"59fc6a18c1151eda\",\"/knowledge-medium/src/vendor/react.js\":\"1d1c1d65b2aad761\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
