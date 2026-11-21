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
		buildId: "c80055d83308-9b2ae0e3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"d4123e4988f6a5ef\",\"/knowledge-medium/index.html\":\"d4123e4988f6a5ef\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-C_sgHRic.js\":\"f08d0b1b1f9def95\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"f062811562024aaa\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-ChMaREY5.js\":\"030e3160c774980c\",\"/knowledge-medium/chunks/FacadeVFS-B8G8Swa1.js\":\"04c02bade84ae9db\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-cRQZqbEh.js\":\"56c265a93c89f814\",\"/knowledge-medium/chunks/MemoryVFS-_ACVbGvB.js\":\"61874067e7dfad31\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-UchVNdoY.js\":\"a82b786e27bc8a8e\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-2rJtC8x8.js\":\"53dcec9b53a56f00\",\"/knowledge-medium/chunks/Preview-Bb7hoGD7.js\":\"4adb78771525a5ca\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-Bx0YsRVp.js\":\"c934b8655543962b\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist--ec0oaUY.js\":\"4c024100bc13d6d9\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BFErMcYu.js\":\"1f97c849f7157c81\",\"/knowledge-medium/chunks/react-BR7RYyRQ.js\":\"ffae2cf72c003e24\",\"/knowledge-medium/chunks/react-C5BSrLHL.js\":\"d8485a551033f445\",\"/knowledge-medium/chunks/react-CettdmN5.js\":\"61f4840964ad64c9\",\"/knowledge-medium/chunks/react-CkYbS1Ga.js\":\"a5ca00a06578e902\",\"/knowledge-medium/chunks/react-CmBALA84.js\":\"01e3fb38d037ce27\",\"/knowledge-medium/chunks/react-CrAybqj2.js\":\"2e7144db52085a89\",\"/knowledge-medium/chunks/react-D7SQLYMP.js\":\"8c71aaa98c203720\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-D_PHBlhv.js\":\"8b6ca81dccfbbeba\",\"/knowledge-medium/chunks/react-dom-server.browser.production-Br7BIenS.js\":\"c807de8b57c210bb\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DR4RvnW4.js\":\"3c4e7cd4923440c0\",\"/knowledge-medium/chunks/server.browser-DrFMbZPs.js\":\"cca4e3e57e224a5f\",\"/knowledge-medium/chunks/textarea-BWFsdo22.js\":\"da1b624eb3d3e974\",\"/knowledge-medium/chunks/ui-zOzG7_hm.js\":\"3ddc1a6a0e001604\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"5b780553ba9fc1d0\",\"/knowledge-medium/src/appUpdate.js\":\"92ba8343a16c374a\",\"/knowledge-medium/src/appVersion.js\":\"447916fefde2b519\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"d4de6e3b9dbef981\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"8cf0ec9610465fbd\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"b03e4c6709b75ea9\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"35a93bbd05c3d24c\",\"/knowledge-medium/src/components/BlockComponent.js\":\"2d413382690c8826\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"643b656b042f2f35\",\"/knowledge-medium/src/components/BlockEditor.js\":\"94a31b46e8ab0c5a\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"8e13435dbfe87395\",\"/knowledge-medium/src/components/BlockProperties.js\":\"3168dd4fe5b407d4\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"bcd448b029de62de\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"f769362384cebb9f\",\"/knowledge-medium/src/components/DividerHandle.js\":\"a4b7e7262055460c\",\"/knowledge-medium/src/components/DraftEditor.js\":\"4db0579a87367345\",\"/knowledge-medium/src/components/GutterPill.js\":\"ac761eb23e603d05\",\"/knowledge-medium/src/components/Header.js\":\"d7de7377ae4b52e1\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"8b8e0773e516e767\",\"/knowledge-medium/src/components/Login.js\":\"436843b161b265f6\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"f940f814bf895615\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"b08d52a0fda93d3d\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"cd3d73688312851d\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ca25d47875490e7d\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"c05cc976e5be9357\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"f8f36ec14670e356\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"d5c8ea14e23953bb\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"916619c573c76d87\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"d39ae04e21cb1b37\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"ed006667e9957cf8\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"a0ddd1c512196925\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"b88f2c53dfea952c\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"4a89fa347614dfd6\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"3df47adb8ad201f1\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"3fc6249b806e96f3\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"aba2b2ff552202fe\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"08a4b03ee829d37e\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"072ecbd1c3a9500a\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"17adf44449ab3946\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"3be10ddbad591a12\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"7493febef8dddb74\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"52278f3b77792b7f\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2dcde1aa87664fd4\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"20c3013334a3b9d3\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"e571925ece174d15\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"3c75d70e5723e9b9\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"0221154a4eeaeca3\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"3b8963905da19997\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"2c42f22e323f5ead\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"48c18b92f7dae4ec\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"8acc4ed73374dbec\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"bc3f9b72dc749ba4\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"08a2b8daa708becd\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"dbf397449e2075db\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"c7d5fc94964058ca\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"998c0f9ec50e5036\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"c4cd3295956eb0b2\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"7fa1e602e5870d4a\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"4a4179ff4a513f3e\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ab21c0dbf0680ed1\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"0b411657b04a372e\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b7327aa9a0e4e241\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"b5b40798d2e44e5d\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"ac1ca9d3f7156986\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"c29840c69ec827e1\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"7cc46fd04931529d\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"9fd88e4c0bf8812f\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"74a9ad861f07cb9b\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"b96980c6372302d0\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"86097a16205751df\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"03bebd8b7deb2c48\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"772ce2d69fa09d58\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"878f79e446c41e33\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"de3eda4223e58e6f\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"d329ff9680a3fda5\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"53985fc45a2042e1\",\"/knowledge-medium/src/components/ui/button.js\":\"42fea016f3d511d0\",\"/knowledge-medium/src/components/ui/card.js\":\"cc69bf3a9a999a5f\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"cf7796e34f7256d5\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"aa7cb4c56f46577a\",\"/knowledge-medium/src/components/ui/command.js\":\"a3dab43d0c4e5bbf\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"4db6d85753e92f5d\",\"/knowledge-medium/src/components/ui/dialog.js\":\"fa93e1b1b87c3f34\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"f8555daa7b82d158\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"96e0461c27d71240\",\"/knowledge-medium/src/components/ui/index.js\":\"faa8a6128222c605\",\"/knowledge-medium/src/components/ui/input.js\":\"6398bdc55c400a52\",\"/knowledge-medium/src/components/ui/kbd.js\":\"eb79a33a8272e602\",\"/knowledge-medium/src/components/ui/label.js\":\"c36b6f93e4711775\",\"/knowledge-medium/src/components/ui/textarea.js\":\"5f0fec2cf73785dc\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"58d6ebdac1c8604f\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"2b3bc11b89935375\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"bda26701d02245d5\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"538104f9c08b1b97\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"e5e6691186f9adb0\",\"/knowledge-medium/src/components/util/error.js\":\"bd8b9bf70a920a36\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"9f8950193f2e822a\",\"/knowledge-medium/src/components/util/suspense.js\":\"a0dc0e9a3b922732\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"756396bee85bf4b0\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"48dd31516559b39b\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"0e825e9ac917dd43\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"791998edf282d1d2\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"10185fec5cb9dde4\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"649d9ad5af6ff31c\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"8b5ab6b9d50edba8\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"fc66fcf600849591\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"73634900d7201e3d\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"b5a79a7d1c0dc350\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"537f9346fae43f72\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"ec64a4d33983e10a\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"785b90e5408eef7c\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"e5b1a752af89e5d6\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"f39861d06c8ef261\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"17fd70bb5101a065\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"eca19857cc5a354f\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"4a864497751904b5\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"de6483bcd5213d8c\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"5e5220f7ed0eb05d\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"e2396b0e48e3197c\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"04cbaa56e5a63505\",\"/knowledge-medium/src/context/block.js\":\"0e4e4c84c9d1f41e\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"60e8c02b97af8109\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"31364208465f8974\",\"/knowledge-medium/src/context/repo.js\":\"5341636aa8b3ac87\",\"/knowledge-medium/src/data/aliasClaim.js\":\"0e23674e52a3f507\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"6833fe250f7e41bd\",\"/knowledge-medium/src/data/api/blockData.js\":\"27427c90bd0d44a3\",\"/knowledge-medium/src/data/api/blockType.js\":\"b7c1c5d891be5ece\",\"/knowledge-medium/src/data/api/changeScope.js\":\"f15a507d55eac844\",\"/knowledge-medium/src/data/api/codecs.js\":\"15c7082d5c5c5a23\",\"/knowledge-medium/src/data/api/derivedData.js\":\"4f7bd5bd91129e7e\",\"/knowledge-medium/src/data/api/errors.js\":\"fff47db01ea973f3\",\"/knowledge-medium/src/data/api/events.js\":\"d5bb51139225ba6f\",\"/knowledge-medium/src/data/api/handle.js\":\"d85cd9b7709e4a66\",\"/knowledge-medium/src/data/api/index.js\":\"be83c5cc9736c2f2\",\"/knowledge-medium/src/data/api/mutator.js\":\"ad38cc7db2465745\",\"/knowledge-medium/src/data/api/processor.js\":\"ce6f649a7a3d9a6b\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"166d9990d1551030\",\"/knowledge-medium/src/data/api/query.js\":\"d22a3095ed1d2cbf\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"e4895c9af4070e88\",\"/knowledge-medium/src/data/api/schema.js\":\"d85cd9b7709e4a66\",\"/knowledge-medium/src/data/api/tx.js\":\"d85cd9b7709e4a66\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"77a686aef6fb1ea7\",\"/knowledge-medium/src/data/api/user.js\":\"235b5a167cd1167b\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"bdadebb2b0ed28ac\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"e0f1cedea91dc674\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"f128fb9506fe56e3\",\"/knowledge-medium/src/data/block.js\":\"864a4442c8054f6d\",\"/knowledge-medium/src/data/blockCache.js\":\"bdd5330dc123d4ad\",\"/knowledge-medium/src/data/blockId.js\":\"a0acdf04aef4fd5e\",\"/knowledge-medium/src/data/blockLiveness.js\":\"ec6f63b15af90c3a\",\"/knowledge-medium/src/data/blockMerge.js\":\"c44133ae9328b50e\",\"/knowledge-medium/src/data/blockSchema.js\":\"0209b58a2ef2eb3f\",\"/knowledge-medium/src/data/blockTypes.js\":\"dd46f97b2e3ed960\",\"/knowledge-medium/src/data/clientContext.js\":\"286a165f1f8c7936\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"365ec225fda47717\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"e08dfdd6ad544d98\",\"/knowledge-medium/src/data/derivedIds.js\":\"b0b8896481079b3f\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"a178e80dfca7c6cf\",\"/knowledge-medium/src/data/facetBridge.js\":\"6fa8c1b40d3a4e9b\",\"/knowledge-medium/src/data/facets.js\":\"2156292dc1c85ee2\",\"/knowledge-medium/src/data/globalState.js\":\"14660e63cb33bcdc\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"1ada8df8c4ef2012\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"45b61020ebac0a8e\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"b0e79c055b6d30e4\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"f7e08f5e682e14cc\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"eb31176b69246fa9\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"e896002d3477606e\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"92e9c09b994b36e2\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"a2c806147f19d465\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"e83791b7a00bf35f\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"5519bd075103dd49\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"a7f7574207fa4d51\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"da3c72f2f93c096c\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"abcb17c6fd2c85bb\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"dea9a8a2ab78272a\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"7830ff6400557ab2\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"9113f401c696e4a2\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"6bb6206df99228f1\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"25c1011c2ceeded7\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"1ecbee91a16c846e\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"b5b09a0a9120c1da\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"4118f056e95cf70c\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"4c663315e8e5c694\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"bcddf73cb58705f3\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"eb90d8358521433d\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4b193c0225da474b\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"3e5d2e2b75f00286\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"90d2dffb98836f99\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"a418e5925953bd7f\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"713c9bbb570540f4\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"f7f4062d3ab1fa1a\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"83c7b864dd6007ab\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"089fd434ac6415b1\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"9102b0eb984d6770\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"12f2446249dbf95c\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"89e60a1e84579510\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"f803f4237a7d9529\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e0ae87325966accd\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"73aed2abf21db897\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"d48041b44d1f42f6\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"772070ed8f5a1bf1\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"1f03326b969eade8\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"77cbee0ad7b8d9c9\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"239d548c7bad24e2\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"5dcb50aa4182a6cd\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"8a1fbccc55eb7b92\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"97f617d9434a43f7\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"93b4f23d0d8bdd50\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"b54268c1539119a5\",\"/knowledge-medium/src/data/invalidation.js\":\"5f3330edd6af5797\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"461ead1a78543a8e\",\"/knowledge-medium/src/data/kernelPage.js\":\"4f18797f2e7a1ec7\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"c1e7c2af8d5e76bc\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"abb21fb6798ad346\",\"/knowledge-medium/src/data/localDbStorage.js\":\"d9d23d03db6ca1ea\",\"/knowledge-medium/src/data/localDbVfs.js\":\"f7960e09454c1908\",\"/knowledge-medium/src/data/localSchema.js\":\"782f84d509531a79\",\"/knowledge-medium/src/data/maintenance.js\":\"235bc098a371d55f\",\"/knowledge-medium/src/data/mergeProperties.js\":\"d37143a5634616d2\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"980ad878c9c9737c\",\"/knowledge-medium/src/data/migrationsPage.js\":\"8cb7d3a2d3715e0b\",\"/knowledge-medium/src/data/mutators.js\":\"77846ab768db5383\",\"/knowledge-medium/src/data/orderKey.js\":\"a41050dc240780f7\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"521448a779062491\",\"/knowledge-medium/src/data/outlineSurface.js\":\"3523a4204db6f164\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"418963441e4b4d5b\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"45aed049455f5a41\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"f632082a6303d707\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"4283c1c2f1f98d62\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"cf6c1e2bbd01e5dc\",\"/knowledge-medium/src/data/properties.js\":\"a3267bfb9cd7858c\",\"/knowledge-medium/src/data/propertiesPage.js\":\"c14fc21b8a98c17b\",\"/knowledge-medium/src/data/propertyChildren.js\":\"c2918bc93950b706\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"1c71b3381f4629d3\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"7d32d9a1581a8427\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"e6a86213e96ad3ff\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"68ae2727df1db5da\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"72e188bab9099513\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"a40e512f6fc3ff65\",\"/knowledge-medium/src/data/propertySeeds.js\":\"714afc8c2b38b5b4\",\"/knowledge-medium/src/data/recentsPage.js\":\"e88586765777d0c7\",\"/knowledge-medium/src/data/referenceBlock.js\":\"7bb7f0811d5d49c3\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"ca2749a47ac4cbc5\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"978310b3554e0928\",\"/knowledge-medium/src/data/repo.js\":\"d8ee00ad708a3bbf\",\"/knowledge-medium/src/data/repoProvider.js\":\"4bf1faf703f00f24\",\"/knowledge-medium/src/data/rowProperty.js\":\"5ce021162c179eb9\",\"/knowledge-medium/src/data/searchFilter.js\":\"6845de7372c06bf9\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"e1ea589dbc6305cc\",\"/knowledge-medium/src/data/stateBlocks.js\":\"e07eb4d2fab6e299\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"d1aed7fdb4a4075f\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"826ecd806fa5b3d7\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"8458dbdc85d9f706\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"712faf8058f8e6aa\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"d03c578a022e9c1d\",\"/knowledge-medium/src/data/targets.js\":\"04dad543707142a5\",\"/knowledge-medium/src/data/typeColors.js\":\"ddb0d8418a31c9a7\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"423846c0c5a698d3\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"a2c40570896ec0c3\",\"/knowledge-medium/src/data/typeExtraction.js\":\"ece0f4dbd65de711\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"a1b75b0d0acec28c\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"9da00bd31ca779ef\",\"/knowledge-medium/src/data/typeSeeds.js\":\"87bef5c8a195f24a\",\"/knowledge-medium/src/data/typeTagger.js\":\"ca7ed762265d145d\",\"/knowledge-medium/src/data/typedRecords.js\":\"40d2d4e64b001479\",\"/knowledge-medium/src/data/typesPage.js\":\"8e9b9bb1407145b9\",\"/knowledge-medium/src/data/userPrefs.js\":\"f13db9e8289f19cb\",\"/knowledge-medium/src/data/userSchemasService.js\":\"1021198449b9c13a\",\"/knowledge-medium/src/data/userTypesService.js\":\"9f0ea70aa8c8396e\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"4b7ea00f856379d0\",\"/knowledge-medium/src/data/visibleChildren.js\":\"1db3575a4e9c2631\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"1744a25753f49150\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"d5b34032f5b77b3f\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"2314a635efb2dcde\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"0d11a3139da1dd2a\",\"/knowledge-medium/src/data/workspaces.js\":\"ac632371f8eed447\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"ce8ec0b78a6eb337\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"eb4243f4548a79f1\",\"/knowledge-medium/src/editor/atTrigger.js\":\"dc37f1ce10a575a9\",\"/knowledge-medium/src/editor/autocomplete.js\":\"0d1cc694f2b1612f\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"e21a6fef7ef08668\",\"/knowledge-medium/src/editor/contentFlush.js\":\"12ee8af18afe91eb\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"7537711abfedff5f\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"dfedca814d5807c3\",\"/knowledge-medium/src/editor/insertImage.js\":\"e7ddd6e5f6c5c46e\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"b897d4f1b924dfe9\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"79128e3ab6d2cc4e\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"9982cf2561e1390d\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"92b5252400ce83c8\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"552ce94593a2426a\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"87565de1708c5f06\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"f1082bae4fcbfef7\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"07a541f21e72422d\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"d2b486585d3b4c7e\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"6394f0b18283d57b\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"f5e6ddcb20978ac5\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"434cb1fd08913532\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"bbcb3319d94106eb\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"2cfd9df55a6beada\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"4fb2f7aef8480621\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"b57d6d5ca1161398\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"bca7c1568cb83d02\",\"/knowledge-medium/src/extensions/core.js\":\"1ff5722afb75ca76\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"271a74b324c96752\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"8fba246cb41b4c2d\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"c83d05679e544750\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"0034e4181ea6557c\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"6ebe9c8c0005ed6f\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"8654ebfb8129e2ea\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"7619e120acb6e626\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"29ae1aae6fb74665\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"8cd57a3bc0fe5f85\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"cbbaeb4527dd85a0\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"de2a45f6f1f51ea8\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"568b81f0f5cc35a7\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"4d9ead8da493825f\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"951d854f27ca48b4\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"e1dfe5a284e93b02\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"70f0363826e57c50\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"3f0ba677763cf078\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"4b1b801644b60299\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"f27fa77568543452\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"a47813a735c5e316\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"311623bf7246e45f\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"d445a474677aec1c\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"36b6bc28b0f46e01\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"00d367cc54d94d3b\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"e2689b7aaf29e23c\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"fa71cea94c177c92\",\"/knowledge-medium/src/facets/facet.js\":\"f257905ef823451a\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"e9b9878a3c07c771\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"f7a671352f93a6e4\",\"/knowledge-medium/src/facets/togglable.js\":\"51bbcaa0a8174a2e\",\"/knowledge-medium/src/facets/variantFacet.js\":\"f8ff3a83662bd078\",\"/knowledge-medium/src/facets/verbFacet.js\":\"1563cc0c392075d6\",\"/knowledge-medium/src/hooks/block.js\":\"d59b71f209054a10\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"f505a75a564b4d46\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"47738bf3d98ed093\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"a9db6d502d17a87c\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"e1cc4eff99a35644\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"89cd98915da70aff\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"33c043c99dadd6de\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"02e4bd86b574ab91\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"1c57ed056162ab48\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"1b7a2816cc38d842\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"66e3d81b32b95312\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"42adc2eb63924371\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"733efbb20b34b839\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"d82ee6cce8e4bf91\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"46b2aa5e9460727f\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"606adaa74bc071a9\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"61356e7f1db7e3b7\",\"/knowledge-medium/src/lib/utils.js\":\"eaad766fa83e6fc4\",\"/knowledge-medium/src/main.js\":\"1862fcadacab3320\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"363f399064888a78\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"419d48a36f2cb1c6\",\"/knowledge-medium/src/markdown/context.js\":\"d6a8d4dd772f2e6a\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"2ea37a628a8ec29a\",\"/knowledge-medium/src/markdown/extensions.js\":\"119456642cfee644\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"8238a1723551dd62\",\"/knowledge-medium/src/minimal-editor.js\":\"50199eb5c2731bf9\",\"/knowledge-medium/src/paste/armedCut.js\":\"ba4c15c03190effd\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"08e5f28148007b4e\",\"/knowledge-medium/src/paste/clipboard.js\":\"6783d4d00762f7cb\",\"/knowledge-medium/src/paste/decision.js\":\"94958376351dcc93\",\"/knowledge-medium/src/paste/operations.js\":\"ace4db5d5a81007d\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"04d4e062f3303294\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"44b805fa5b3915b0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9ec723a607716cca\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"15fee11e6c96be12\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"40084a470055b8e7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"86761fbc02913027\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"0c68d992a2d585de\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6a2e446920c495f2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"5bc5cb277763f342\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"62ffea07050064dd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"46f880766aed22b5\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ac70aee3ed61b9c7\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"15ff8b34b74d93ea\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"2ad59224de0eedb6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"55495c15666d41be\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"314242b209b3e7d7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"054fa6d174ef7ed3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"97522196af0e1f52\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"885cd74cf56f5dcb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"a523b234a2cdd4bc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"4d84509236a9f763\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"33898afb917d5ce5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"102f5a6cf8fdec49\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"f5b17dada8851e69\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"0f254e5b2aa5553e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"42febd075bc1b135\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"23e12f7e630f9bf4\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"c468c5132bf18b96\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"20d9f31cb2f038ea\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"4ccaf2c42a48f803\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"bd79d5be0ac22abc\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"21154dcfd213e4d3\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"5445bbdf9c21ca85\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"fbb205e28121a399\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"52cfa715b0a46fa6\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"ff7abfca0935c0cd\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"a139e113192ff39d\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"508844380e6c0876\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"6c715eb4d7a801e7\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"7fd4cd13a3f70cca\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"cf8ed0737600e6ce\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"b279ea2aee0db361\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"a326523e7042359e\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"00bf8fc66c1a6d15\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"2f006b78bb7e2dec\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"564aad806a236927\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"5dd54a8479631a02\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"82749718c4894d90\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"82b7c4e81605178a\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"5ff4f87062bddeb1\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"f8200afcd22fff06\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"f3ca9177ddbf6708\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"36540463641c7515\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"d7c68ab145f6518f\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"b04210f5e87191f1\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"6511f99e7126421e\",\"/knowledge-medium/src/plugins/alias/index.js\":\"1e3e6c02a6bc751b\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"bad87f5e03c1ebb8\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"703225afada86c5b\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"bbbc443b4e8528f3\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"db845a5ef2b7a5f8\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"3f29674431bf0091\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"2808c03cf5211bc1\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"6e1517f817e3be82\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"6d4f33a3f6b2cc44\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"f9126f926cff3ec5\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"ee40af98feaf0ea2\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"1b3406978b1fa3d9\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"9e1f552798b51e10\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"1f058dc547c5d677\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"45ee4894b570190d\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"dc7d1c91b87cfa65\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"2736206b5eea5425\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"ac11bbe20dae44c9\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"8921fee3d87f2bf8\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"97f24f9fea9ffe43\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"2db6f69db20a332c\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"236951b630fa8b09\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"59d7718b770ba860\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"39ad30caa43760b9\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"0c2e8dc5b6691bc1\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"30e4e79ae08dc885\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"fba8c1be9f9eecd9\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"854cccd006c0c173\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"f5749adcafc00fb6\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"df6471759a1abd42\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"ac8cf89c056008c3\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"fad7d5486fb0c35f\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"67993b80481abe6f\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"ed0fc49914cb6fa7\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"a681ccd132670344\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"3f765c91e3c15f35\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"0430a1110153cd11\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"29b09ee3a557c115\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"2e8cc47d1ae7fb6b\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"e08f10efa0d65900\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"b6f7335ccdf0d36e\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"039c79136b2e2db7\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"2a0f6f4326bb4acd\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"dc284b68be9fe6cb\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"19e711d62ab87a67\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"1abcfc7343aad42b\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"8193bafd935d2cb9\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"2e2c244345cd9b53\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"acdd6ad9039098ff\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"fb3f727aff5b8592\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9ec3e7f64282092c\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"2699ff5dd849f944\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"23f7f27a296a4b33\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"340d1c6420947b6e\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"20484962476c6be9\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"0022469f6162b143\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"01475b15d3522244\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"c167f592594c101d\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"5c1d31b3cb033b85\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"21d4c52fdadd10c0\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"1edf397ebaaa0494\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"5919a4a7de178d36\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"9bf2dc9de686cd42\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"bb8333559bc5499a\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"1310aac4f3c8b4c0\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"bb6e6eaf129e204a\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"106fab2df8a08c9b\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"ed16c8ea75458841\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"5fcae046cd08c24b\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"606e03e98ac09e39\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"4c98727f727e3263\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"2aa38dec4c4ce743\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"98349115606af6af\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"7f70e4826a9055c3\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"88f8fdf15f5d4613\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"d2cf67a8ae3727c8\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"86177f399e57e4be\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"9a1e64bd7803616b\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"e85f06fc608e9eec\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"92937a099d6cdbcd\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"00762bc1410ef97f\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9eafa69d247e3762\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3a8334b440e449c2\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"8279a742ba378811\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"576077fd69bbce3a\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"16930c0f77033ac6\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"4427f805431b0c46\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c5c33b00f55b6bb9\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"50621fab663f74f4\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"cfb9283ed69af640\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9c0fe306d074ec97\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"92795274c1d7a0d6\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"60ff8dd88d1cb2f6\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"014dbf5fabb349a5\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"c33f82c6a51aafff\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"013071b23e3d8241\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3a039251612c1ca1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"edc94b3db0aab271\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"364757347cde6125\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"01530778def3d4d7\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"e092a2862a6d68a0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9c8517d1690559a7\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"0a7105cf3bcce648\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"08b7789fff9e1978\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"2c3d310a3f8520d7\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"7081708846d9de12\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"f12e178049bc9134\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"a43f89e0c23012e8\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"f5bade11c700e7c0\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"ae933c7eb6e1dbaf\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4134cffc895fa6e8\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"8cc6455e3b849c88\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"97bed2e680d1aca8\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"d6c58b31fe976ac9\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"eb0d38eadc86e1e1\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"41d1cda0b9e8a866\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"56af3d1b026cd92c\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"320f4f15d11e9415\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"0e6e43735888a9a7\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"e28a118b4fe1ae68\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"c3623a6ead75dcac\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"c2c38ab1b955d610\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"de62a057339a2fda\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"87d2d4f95a9096e8\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e0e82b8b8f388f5f\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"a9d4aeb4a98884fa\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"b6532d4c89ec308a\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"6d532c9ee7c289d9\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"b12e8a3d6cc33afb\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"595d60884e6b4346\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"72a74988a7a739ac\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"54e0c5a3f4fb0388\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ed2b66a1d85b6964\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"bf74f04e308e5713\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fc1f08ae554cb592\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4efa3909b2ce8ff9\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c56f468a1d20cfd9\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"cdb615d2c5036c5b\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"19bb08a7e1014df2\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"c4d829c2b6583624\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9602171c0e0beca7\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"90b4664f52120110\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"8350bdd5ee24e2f7\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"f47cdb5fee07692f\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"d233cdf12c10b6ef\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"0fdd4bd08979a6cd\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"5fc5ae6d3426c5c3\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"d050d7b58e178316\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"bf7ae4baecbbeb2f\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"cc9893157a24ad17\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"45b579b29759c450\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"6ee371be2148e2eb\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"b661abe20b54a484\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"135fec2b5d618468\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"4c7ab305702fab25\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"5cd0a08c68702c91\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"cedab574de77bbd5\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"c8180e385d51f35a\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"1dfe4dfbc7314683\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"0928aab129842edb\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"ed08518bd91d77a8\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"0b0bc20788d7993c\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"f07989a3ee1744e7\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"58731f5254a6dded\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"c7c53241034665c2\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"45cbe0d3ea22dd42\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"e03578000179c3b8\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"5ee62679df4e2e2b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"5b4d105fbe903de8\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"30d0559f7c013185\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a142523f5c68a4b5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"57d0a74fc22b744e\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"f972a8484d1edfbb\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"68581d05c6003715\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8503b0def4e5dfb0\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"2a37c9c500726244\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"5c3a438a23d5b429\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"88144039f7e02add\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"2d8d1a3e94269d29\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"11cdfd35d769d360\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"63187a24d43ceba9\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"3f948f977c17fb79\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"055b1ea0980ccb92\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"814c15a3100e5381\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"6e3c2c96a49f69f5\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"c3caf9dab2335d5d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"0bea2d0f9fc5d206\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"9d6f5346ecdd28ed\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"81f4580277cf3840\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"1d94beadab192dc4\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"1c25a88ae3e3cbac\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"7f034105e5480ac2\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"a3c4b8668e629f3d\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"0700e40f0be41cf5\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"9027352c238aa8b6\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"0d97b01ea012c4f1\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"eb845acb809da668\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"b3c12529aa7f82cc\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"7281e73d9a229792\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"c344a587d1f38852\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"413f0129a9c43db0\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"307b89d509848373\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"e3ba08b456cf82a0\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"8b0f93eb9deeedfe\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"640099aca7f14248\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"43c63c6c3c1b3100\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"907a499479495166\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"f8f73e47979d32b7\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8f66b57e65539866\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"6f77f7c41c3ceeae\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"6e8905d376de6411\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"3a74d96aa267c1af\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"121c9fabb571dbd8\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"3a58a5b5ef37f186\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"4a0c18085199994e\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"0778e6b0123f55eb\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"cf681dd449793b09\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"9118788c07d0d0c4\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"118f75e907d0eb4a\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"fb6ec0a3302645d1\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"00c472f84b84c9e6\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"6d536ddbff767572\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"1ba4f3dd6f2e568a\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"308920e1f72fb47b\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"c0159afa280bffa7\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"e66972adc720858b\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"c4db304bad9b3624\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"8a701b74d2e32e6f\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"ed6b3ab35ebc6604\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"4da2656ae0218bbb\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"115b3e1c1855c1ea\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"a4e0bd8e98e7d54b\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"dc027c7969bcc017\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"e1b6ede77308082d\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"da0bd95943626449\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"af62e849ff5355ef\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f52f6d7c820910bb\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b7e1535a9d11aa89\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"2578ed1ede60b804\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"14cb53f6658d42f6\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"7273ba16cc7157cd\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"fc7c1b3c9a920f05\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"17cb7e472404c887\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f4121040e87c725d\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"d477fd50ebcc8864\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"51c2d602d727c169\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"7b466958cc7e73d1\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"a779fe18eed73d8c\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"7d06a99ae6971edc\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"b87dd7fe9722f8cc\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"9db93dbec79a7f53\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"a00268a66c3b431c\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"763c39846ed0608b\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"f72f650caf1a474f\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"66f8b12de4672639\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"1d9e08dd46bba7d7\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"0b8138bc3cf80179\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"ead58307d2464dbe\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"8f575e08d391c63b\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"4952fa873f030237\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"3b5c5e6b674ef51b\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"9013e43ce8c64707\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"4e54c8c5964175fc\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"000f63bb435839bc\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"700b066651ab13d3\",\"/knowledge-medium/src/plugins/geo/index.js\":\"11479f0f90fa9c63\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"224a524730e05622\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"bc2247c57c082760\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"3c32fe5e73412799\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"433891a776b91d52\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"2fab723498be1edb\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"1b7a36485d2d89ca\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"cc64af385c73e61e\",\"/knowledge-medium/src/plugins/geo/query.js\":\"086b62993fec39ee\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"a050418f3a2edf96\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9250828457a3054b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0a63f00dcb436ec5\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ed27410b71933310\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"25b854fc62d5dacf\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"079e0378c2e3356d\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"56b6092a0a28da5a\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"0b3892388aedd7a3\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"5288564ffda1557c\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"cf49f9b0f1e9c871\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"bc3a02365f63dff7\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"1804fb7bd3d8d765\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"add1171ed3e34d7f\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1a33613b350be84f\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"bec31f2b390a73e3\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"ee4c2dec5ca4e1b0\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"06263de421e00822\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"897155780ef9c649\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"c9b816f48926e72e\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"e938c58d38a5f0d7\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"6458f491d5af3cbf\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"e5796aebafbe1c9a\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"66b904528c19d0c2\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"b2abed42a74054b7\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"3d167ab98945e610\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"4bc864f1da9cac44\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"7b7d836d9a0ba24e\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"5af733a8ae498d5c\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"55eff192c930cda3\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"9c5a5887b684a869\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"94c33e97d55ad6bc\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"bed931a5cc1bb015\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"3e0e145396515735\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"8d580cdd080d664a\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"67d41e30366302c3\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"010505846550416c\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"721585856223ebea\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"b72c4e43fedd9e9c\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"3af5657510e79772\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"e10f79575cd6ebde\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"02c221998a07ca38\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"fc67962d28750778\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c2b70eff0399e85f\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"04c2f03423a0eafc\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"2a374047462611bb\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"c4cdc1a412980f1d\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"6a8e1d1daa9ea965\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"aac3c6f404980cc9\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"ad4846844035b3c7\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"35d14a75c413ed64\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"c207f9d7aba467ca\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"3d015dfe7eab3a13\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"00d97a9024133087\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"7beb6fb203127c3d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"6b3b3af7792f5a76\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"7311fc6024e1cbb6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e28a483b1433a18c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"78da86315d9c85c8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"3cbbf738bc34823c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f5643b8eb95de5f3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6a8e26aaa86bfc3a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7cb9ec3e4b0535a6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"01f090fca4362cb1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"2c69e460cad7049c\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e8c6692167be3f4c\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"febc88fefcdb8863\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"5987071ac6d460bc\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"6c69c8bafcc7b662\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"791945b79e4dec95\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"a7433858e0ccac30\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"5870b53ab5da5916\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"8273ee47f29a1c8b\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"87ac8c5e17e67acd\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"0567bd4d8dd1ab24\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"9ab835df83b05266\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"329854dc0136eed3\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"043009459f3acdb0\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"f5dd52e98b3f8769\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"50e066624076c3c7\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"945133415d4c2548\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a39a96d6821ffd18\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"addb067bce6389cd\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"92f3b7ce0c7e40a5\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"4642a4ede7c037e0\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"fe01ee85a3afea05\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"edd6b17c847949c7\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"5fac12efe0aec0b7\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"29d65dc40ad64d12\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"b44ef47b7b8f711f\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"6268a0b49abd1430\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"560b489f50f09237\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"5f72b1a10e9bde9f\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"54e9b2fcdb18384c\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"6043d20f5163e32f\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f07789cdfc13e2e8\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"6a68786a6a658d69\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"4aac96b2c5d031f7\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"8856d82b355b49cc\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"1a2a8e40aec5564c\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"1129c84f4ae391d3\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"6d860b175d02b9c2\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"e3cf3e091b7f0628\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"3237d3584f6d9f72\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"4e8de0d30b684259\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"f7ebc3c4894c16ec\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"10a8b0ffd92ce6e9\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"6e4c1cfe5c151e5d\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"e46cab07621f860f\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"522fad4507252a99\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"5bcc52ecc50a7138\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"37d04ddb955d3f3f\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"76123feeb0551921\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"4501448f73f694de\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"56f74ee05fc15236\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"c9b7e75e759eb6ac\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"c8e436f15f281140\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"0542175c445e3ef5\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"7418e538083df5a3\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"8ae5e558a28b66be\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"cad4923eab6cfc07\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"52739531ca02880f\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"2802160f275bac7c\",\"/knowledge-medium/src/plugins/recents/index.js\":\"2f566a513c69054b\",\"/knowledge-medium/src/plugins/recents/target.js\":\"7bdc04b42f3a4bbb\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"427de63a133a68dd\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"af30fdb312b1f3b9\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"57b2a0967ffe5d98\",\"/knowledge-medium/src/plugins/references/index.js\":\"e79ab49f05ab2f3f\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"bc8ea460d71546d6\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"958f2903f6496b75\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"261e0b78e709109b\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"fad459675e31eaec\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5944adf99cc5a7a3\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"52798771a5307544\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"56539e10ac460d4f\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"55d8a52cd6462497\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b3c8c8c90f43254a\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"fc7a5235b3019d84\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5f2fb7a97588dfb6\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"beec7aef3538e64e\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"ad55f2ac5550305d\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"5ffb798a6544fba1\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"ee15890314846824\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"a36da078a1e2ed92\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"d8dd46e395da8fd7\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"8d86dd147a0a236e\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"8f9283eafc08f6ea\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"d26dc3acc55239d9\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"f29b58bd008bcfba\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a02e0685f92fa137\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"bd05d0badf651972\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"c1ab175a9311a4ec\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"06e6b747b7efefdc\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"e784f7b3a9d50596\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"dec694cba673bfd9\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"b7cf214cff45da3d\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"5922cd1c765280f6\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"99250fcba3fb6f12\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"e9aacf930acd3924\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"129e5082c06c874b\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"5345985fecd17855\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"2f482c9000a32369\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"e29cac53ae4c74bd\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"63aaf9fc25b0c114\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"6280c70a94202112\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"9f1c73b14e6949b6\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"4a100abc34fb02e4\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"0d15afe2433755d2\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"14db1cda8156a7b2\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"046ea4b8c15302fd\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"0193dc71bcb01809\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"90869db244a2fdb4\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"98948bd09e99706e\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"b412dac4eee98d47\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"17846861769af045\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"940262580c49f03a\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"f2ecf4c4affbece0\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"0975ee5a23130d01\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"24e4f8178113967e\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"83319bf1d79a0af8\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"037beb3d17e32151\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"f3d7414200aac74d\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4b9ec2c9501253de\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"7752851efc1a21fc\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"55dc009625f1de04\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"f172dbc3e93f62e3\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"234f83b09f79760a\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"9eedf4959f19d631\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"d7a6f353d8ec2371\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"b92ec09f62f9a311\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"97c5b410e5fda255\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"519d3fe11318c1c7\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0cd5e91fac6cde29\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"22fc0ebf6aba0289\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"749b580416e47627\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0b6ce158264e04be\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"6d8ee43dfde285ac\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b849776399fc7927\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d8352954d8cc5f1e\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"734a1448ef1b6bdb\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"936a7b023b92ddef\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"55e08aa33b50b540\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"c8c61f0fb381cc5b\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"91f8596ee58fbc6c\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"201e34a05bdd7604\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"911ff074e2fd47af\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"a91f7c576e338404\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"80ff30a4c798ace4\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"1076469683949fc3\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"57cb098905c83fad\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"bb7e3bb828fcc739\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"aad66c139376d5cc\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"e5013e76c64a9e8f\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"e6bdf7ae1b2fb899\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"886ebb638f90703a\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"6057d4926682519e\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"a674c07905ee827e\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"078c3fb425a4b711\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"00e9f42bb50e2c68\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"1e14a96b62a14d41\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"3bbec34417d47fcf\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"2b3a7522e1f803a7\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"ff11ceb7e84a3219\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"8055ae6fbcc527c8\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"bffb1ccf42b77f9c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"f0da5f14e8fe39ac\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"3a052ac192b86af3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"322d7a6ff6250a8c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"c87a25a9aa21ef98\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"76e2dc7e879d936c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"be078e1bee237a9a\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"a525c0b67658b3be\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"ecc51a66e98f2678\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"8aa58846f526b7d7\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"e41795d0acdac7eb\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"afcb8cb15f55926b\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"7436d4f087f45eb6\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"7a2214b20aa6d3ac\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"987459a9ffee9b31\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"9f24381c327e97b2\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"60959228c7ea6bc8\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"b86f63e051341fb9\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"1826c50e844c95c4\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"320f16b8e9f2af66\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"58bb3dd049987662\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"76d59ecd0621c1bf\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"abf53576eec7ff50\",\"/knowledge-medium/src/plugins/todo/index.js\":\"b5fc5053508abc2f\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"24a41962c0f9ec9a\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d02c0c2bed6f5b41\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"ee3822e0680791a7\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"7799901606f00432\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"6a7f2f1e295b7278\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"9dd6a9e308761f32\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"72db9af6bd61c4b2\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"28eccb5b157b0593\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"311b979cb4619005\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"645dc3717246cd63\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"8f2d2f1d2501a769\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"eb35deb28e585809\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"5f8f8ab089354b52\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"52af80fff831bbcd\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"7cffe446ffc2e80d\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"dd6897dc3ee5de3e\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"63872dcab910452f\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"cc18ca8b77b5dcd7\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"c4280e1c777739a5\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"9246f91555ac2429\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"7b35fbc77470901b\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"91a4f6a36978984c\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"49083820b0ccbde5\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"f0427070b73666fa\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"1bd2509a80e9de07\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"938513129f426e9e\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"9d8a74c3b6d7c58e\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"a137dd765fe7ae44\",\"/knowledge-medium/src/registerServiceWorker.js\":\"54fe5e7669858b1c\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"69f3e1c35bfeabe6\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"d99260a57daefeea\",\"/knowledge-medium/src/services/authStorage.js\":\"363b42f0af1bccfc\",\"/knowledge-medium/src/services/powersync.js\":\"4279c5dbd78c3477\",\"/knowledge-medium/src/services/supabase.js\":\"5f4466540e412cd5\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"32bdb89109c8e956\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"6ad545c8065bb095\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"0ccdfb6539817318\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"8e8bf772851eee7d\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"8000d86e1351cbef\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"da97ccef6add7567\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"78551955195ff220\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"db147fd583f23e71\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"2f6e7e3eb20b8492\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"7dfdec5c48b3d5fd\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"2af6a34de310593c\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"0d0273567937dbb7\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"41337b267895fedf\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"f0da2a1713138617\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"8591484a316c1264\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"ccfd31910ecb0e56\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"aa41d27b9c6b6109\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"2b1d3250609721ec\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"9fb780d4cdc39a34\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"826649b652f19b45\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"a5c6dc49430e43cb\",\"/knowledge-medium/src/shortcuts/types.js\":\"0f02163fdfbadb90\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"571a8372956d50d5\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"5d228d6bc997a594\",\"/knowledge-medium/src/shortcuts/utils.js\":\"741dbbd6a1bf9d7a\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"f5fc6c5647b60789\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"e25617e5b6a8efd0\",\"/knowledge-medium/src/sync/byteTransform.js\":\"350ba408fcf4e79c\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"6b56dd9d1cbafc96\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"72cbab896b1ffa33\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"1f5746d57909e509\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"bd6654b470f6f02f\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"74c7825564348669\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"a228327bc32e35c5\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"6ab810970be48408\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"fcd4b75756c7e27e\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"b8612e61bc537917\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"68df3f0aa288110c\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"b7a61265db162dc0\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"8e62371591f98d47\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"d1c58372372c70a5\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"13d9ecd04af9d08b\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"3cc7696b00aa74a4\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"21a4285354db56e1\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d240f3dc5c2c65a3\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"1ff7e88fd8c60a22\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"a2a1b33aab89b437\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"6c8e55c4307e373f\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"26e378ad3abde8da\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"f2aa966d015ce205\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"bc0966bfbe33441b\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"b5411d998a20f59a\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"589b3712a88eacb7\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"85798bb2056caff1\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"ff0c6bd64c799e83\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"8ac6b4e924872522\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"cf40ce871d8ee01f\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"49bc33a90a285fa3\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"0f66ff69978994d4\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"2ad390e78a966745\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"a4e59fd1d6137227\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"6dff37de2fbcab93\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"5c22cabbc96f9299\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"e4a76d8d705db405\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"8d0078a2e1130e4e\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"692da11d25cc7302\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"d4a467c5b065c28f\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"806e66bb81c19a98\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"6b8ae6f4a24a5cb5\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"3ef202ede7a8015b\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"cc37ee901de0a34c\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"1f084b20c0d1de82\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"97f770e93ec76310\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"07c9169612dd1910\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"658c3febfdf7f70b\",\"/knowledge-medium/src/sync/transform.js\":\"f9c1f968062d7591\",\"/knowledge-medium/src/themeBootDefaults.js\":\"489a4ef6f465cbcb\",\"/knowledge-medium/src/types.js\":\"374d0603349b82b3\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"abbd8f7dc0dba165\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"ed2206c0ed2c07d4\",\"/knowledge-medium/src/utils/array.js\":\"3b5d58c08ccad756\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"2272c8fe5c079580\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"32ca9ea0a45d47c7\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"96a3ee713279af34\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"d58ac18fa25eed19\",\"/knowledge-medium/src/utils/callbackSet.js\":\"d6f7bb2cd9a6154f\",\"/knowledge-medium/src/utils/clientId.js\":\"d9ec4b00b56082f3\",\"/knowledge-medium/src/utils/codemirror.js\":\"63192ced3f40eb4d\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"86f299241e884982\",\"/knowledge-medium/src/utils/copy.js\":\"16bbfb3034eb791c\",\"/knowledge-medium/src/utils/dailyPage.js\":\"e2cddc3c0d216f66\",\"/knowledge-medium/src/utils/dbForensics.js\":\"47a808baad3b9a62\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"0e2536d17efc2422\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"53860e9ce0f424c1\",\"/knowledge-medium/src/utils/dialogs.js\":\"045ad55da8878a79\",\"/knowledge-medium/src/utils/dom.js\":\"e8576626f3ab25f8\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"9b832dcfbbb7062e\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"0a0225fa1689ddfb\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"1bdcf9c414ac987c\",\"/knowledge-medium/src/utils/flipSlide.js\":\"02949bbe9e20c775\",\"/knowledge-medium/src/utils/fnv1a.js\":\"0e171cde87b37ea7\",\"/knowledge-medium/src/utils/formatBytes.js\":\"d2b6ad470ae5f393\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"107597984929edba\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"3f96de35b1d9a8d6\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"97ea08645970bcbf\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"d5416aeba8e7e486\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"6a00f7dbcc55586e\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"32c271cc6a7336cf\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"f629c761644f4d65\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"a09e8401f59a3ac0\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"345dc787b6e47cc4\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"9701cc251db8dbc0\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"02cc3f5c418b155d\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"cd8a058c0890648d\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"0c93689bac3056e3\",\"/knowledge-medium/src/utils/markdownParser.js\":\"e69cf3b195105d04\",\"/knowledge-medium/src/utils/memoize.js\":\"b7ca493d172da92b\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"57ee3fe1fc905401\",\"/knowledge-medium/src/utils/nameList.js\":\"53d64b3272f6b504\",\"/knowledge-medium/src/utils/navigation.js\":\"cd9ee5ab3b061d05\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"1b1699c486c0af1d\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"3a24383594b128dc\",\"/knowledge-medium/src/utils/panelClearance.js\":\"dd8d4f549968afd1\",\"/knowledge-medium/src/utils/panelHistory.js\":\"476015066cd491af\",\"/knowledge-medium/src/utils/panelLanes.js\":\"e16535ea23197042\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"cea67566e23a2b69\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"2d21c74c3117fb2d\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"9f5ea9f718445854\",\"/knowledge-medium/src/utils/platform.js\":\"429a818e9472862a\",\"/knowledge-medium/src/utils/pluralize.js\":\"fcb44353692eac39\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"02a325a6fc7a62c6\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"3fe4c335a7c88433\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"0a1293853fad6306\",\"/knowledge-medium/src/utils/react.js\":\"044988e0fdd77360\",\"/knowledge-medium/src/utils/relativeDate.js\":\"7be9678a2561118b\",\"/knowledge-medium/src/utils/relativeTime.js\":\"d6ba86ac040096d0\",\"/knowledge-medium/src/utils/renderScope.js\":\"14051d98c34755af\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"cf4b6b61ea6a8898\",\"/knowledge-medium/src/utils/routing.js\":\"11526d227c6deb44\",\"/knowledge-medium/src/utils/safeMode.js\":\"a2dd7a847cd8956e\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"003e04b8b7fa6d1e\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"b916069e014c26ee\",\"/knowledge-medium/src/utils/selection.js\":\"0a2bfc74be8247b3\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"24841ab7fe6add91\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"ee96fa4525d7042f\",\"/knowledge-medium/src/utils/state.js\":\"b82e660a2dc47924\",\"/knowledge-medium/src/utils/string.js\":\"ed2bfe6243185596\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"9da0bf26ece3ad18\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"13523a20c2a25163\",\"/knowledge-medium/src/utils/toast.js\":\"9725cf956b941f67\",\"/knowledge-medium/src/utils/toggleStore.js\":\"ddbca0f7e0db1bbf\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"cc1d647acf1f893b\",\"/knowledge-medium/src/utils/userActivity.js\":\"b1ababf023c289a5\",\"/knowledge-medium/src/utils/viewTransition.js\":\"f8ad535b40c5a408\",\"/knowledge-medium/src/utils/viewport.js\":\"d03ff38c5e0e9507\",\"/knowledge-medium/src/utils/webLock.js\":\"0044c00ef87d23ba\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"6fe566d3e8bc542b\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"2cbdc3a6f00fd1ef\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"018e7caa814da1fb\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"0aaec05c7fffa822\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"eba6c25187600d2d\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"594bd06fa2bd2df4\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"49d549d4a343c549\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"17bbf14838cd9def\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"9b176468d89b35d6\",\"/knowledge-medium/src/vendor/react-dom.js\":\"c42a0373a39247ed\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"41d44dda031546c2\",\"/knowledge-medium/src/vendor/react.js\":\"ab06968c34b244a6\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
