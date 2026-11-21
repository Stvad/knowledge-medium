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
		buildId: "6748004610af-9556ffb4",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"11e7f881efd11b9d\",\"/knowledge-medium/index.html\":\"11e7f881efd11b9d\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-B1DVV9Mg.js\":\"fcaeea6b3ab05977\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"be5acb8d3b7eb751\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-B5Evo4UV.js\":\"1fbd36f1e96fd4d0\",\"/knowledge-medium/chunks/FacadeVFS-C-ZeV8un.js\":\"a55cf06862266891\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-UV-O6FBw.js\":\"405b24afbe0f2782\",\"/knowledge-medium/chunks/MemoryVFS-BjA7G3ME.js\":\"b6cf5779e5999f44\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-YEICOMLW.js\":\"f209770cb76d29b8\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-Bl84pxux.js\":\"d9fd143fa2c20446\",\"/knowledge-medium/chunks/Preview-CsDgvWpm.js\":\"9a9fbe8702834372\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DuAbcanN.js\":\"8923ef92dd27e714\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CDsu7QiD.js\":\"12c1ea37429fc13d\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-4v7p-nDz.js\":\"a94e39a504947f71\",\"/knowledge-medium/chunks/react-Brd6sXa5.js\":\"3ed517f3bcdcbdfa\",\"/knowledge-medium/chunks/react-ByQGAUiG.js\":\"b043d4d021510e39\",\"/knowledge-medium/chunks/react-Cl2HsBPy.js\":\"028e0a9405601535\",\"/knowledge-medium/chunks/react-CpLyOh1c.js\":\"57b6a23f4a7a77d5\",\"/knowledge-medium/chunks/react-DOWKKwAy.js\":\"d7f88cf17bd5bd30\",\"/knowledge-medium/chunks/react-DTtJ_9v8.js\":\"f3a3285767182460\",\"/knowledge-medium/chunks/react-D_8IfRDk.js\":\"50205b1ea636334a\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-C80ZXLoz.js\":\"68cdfb513d3eba45\",\"/knowledge-medium/chunks/react-dom-server.browser.production-61XY9ZCD.js\":\"bdf528a39b42844c\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DuD0KtAD.js\":\"cd3b9d64f45fdf89\",\"/knowledge-medium/chunks/server.browser-CXoUSkLV.js\":\"0dfe66eeebaec841\",\"/knowledge-medium/chunks/textarea-DsirSEwe.js\":\"b4cb9089b4e71d44\",\"/knowledge-medium/chunks/ui-BXY4P6TO.js\":\"41e89eacff74432d\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"0505d14eca6cf029\",\"/knowledge-medium/src/appUpdate.js\":\"f8f498a4dd3274f9\",\"/knowledge-medium/src/appVersion.js\":\"c725a666454a0b3d\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"6a188fe00a4ef7bd\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"2161dc53c9b11cac\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"b382131569d216f7\",\"/knowledge-medium/src/components/BlockComponent.js\":\"e6a78cfcaad0250e\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"d632218418b595ed\",\"/knowledge-medium/src/components/BlockEditor.js\":\"d3f1b0ec1536d6e3\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"5020e5380add781c\",\"/knowledge-medium/src/components/BlockProperties.js\":\"0e7667a15de96084\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"c12d1fd67af505d5\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"f5fd72e42abf96b0\",\"/knowledge-medium/src/components/DividerHandle.js\":\"ace29606a599f055\",\"/knowledge-medium/src/components/DraftEditor.js\":\"8e1f5c49181fcb60\",\"/knowledge-medium/src/components/GutterPill.js\":\"6241294f099040f9\",\"/knowledge-medium/src/components/Header.js\":\"775ddd9d9f71a0be\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"c5d3c5f641898dd7\",\"/knowledge-medium/src/components/Login.js\":\"28c516c3d39f29a1\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"66ca5634ecdd84d3\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"b211fc14a66ba3d2\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"332d44619f1a1f07\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5c5670ce14cb5932\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"ad5d87a153fb24ef\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"66e04726dd0744ac\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"3005b4d9e39cb273\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"fac788c386bb8d81\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"b9783e7f5e063add\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"c67874344b99b171\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"25ab5e11aa0a12a3\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"b7fffb4eee20941c\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"915b43b9c28db036\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"9d806ebcc6787a39\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"c30b6e1de872f2b2\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"49da7304861f275f\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"54f053ede1bcb086\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"c38f8f60ac683f02\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"3dfb27e7718853c7\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"0797521882154007\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"6457629ca72fcf59\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"01125dc5dcf6a292\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"623e126096229bea\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"5036ad90630f76f0\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"29a182f36149e67a\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"ed540b953da3097e\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"6b3354a3bcdeb2c7\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"0bedfe57a8f2ba33\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"df8d7de09b227202\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"a7ca2e011b2f6f59\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"f04bb54f31f04a07\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"f196456224ec7807\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"5057259f5abd225f\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"40eb21428919f993\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"ee8ae6eacee8552a\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"a085ebab02d520a1\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"e22bacb18f5d2c8e\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"a317d442f7ea5afb\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"e625826d0111aa38\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"75efe9ccc7f0bf3e\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"ef21d13010590d77\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ba66ea1cbdbe2754\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"fb085d42340b3319\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"32ec04e78c0559e4\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"2d8e1152a1446dc3\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"0cf7a3724e358089\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"e1de2b43d1e99ae3\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a54e98ad7ba66b21\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"83b7090f394b3a3c\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"05c79448d0f34ee7\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"d41f010ef2ab3db9\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"aa151d4715fedf3b\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"e49a4c4baca7456d\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"cc63fd78d90dc664\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"ca29434815802f31\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"13f26e977f89dff0\",\"/knowledge-medium/src/components/ui/button.js\":\"9db0ebfce86216bc\",\"/knowledge-medium/src/components/ui/card.js\":\"697547230377685f\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"6deb32dec050eb6d\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"eb50c3eaf5a9340e\",\"/knowledge-medium/src/components/ui/command.js\":\"8f0e08f71efd867a\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"1ef74902314aa905\",\"/knowledge-medium/src/components/ui/dialog.js\":\"73c00091b5e20333\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"30ac180115b5548a\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"daa3e19dda3592c2\",\"/knowledge-medium/src/components/ui/index.js\":\"339c1798146bc51e\",\"/knowledge-medium/src/components/ui/input.js\":\"ab9bd90b0283746e\",\"/knowledge-medium/src/components/ui/kbd.js\":\"7627b79e1bb4059e\",\"/knowledge-medium/src/components/ui/label.js\":\"525c17ec720fef31\",\"/knowledge-medium/src/components/ui/textarea.js\":\"1b63d0f56da073d8\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"b74153cafff86ea3\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"0d642d0366438e56\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"5bb338da544c18d0\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"3f8f5783444a7c32\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"a45a9b9525205cde\",\"/knowledge-medium/src/components/util/error.js\":\"f8e61fa34044e1f7\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"a12df1cff8ffb3a5\",\"/knowledge-medium/src/components/util/suspense.js\":\"429055e17ee2c4e6\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"d1a05af0cc2e8a82\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"842a5bbb27b454c7\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"c0c430d7a5f8e844\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"2ea38d797099fd91\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"d2d48be36fa529b4\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"adb5697290cda4cf\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"c2eb25cd332c1a8d\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"cee71874ab45ae19\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"b6c00116c20fdb50\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"975f3b6b62971fa9\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"2804b975ecd87625\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"211e6d1a12b32ad3\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d6437951ab75a8b8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"2efd1996ba121295\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"315614dbf91911a0\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"c27f0088b2085a36\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"7ad6285d60344d61\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"ac0e812ae0dfbc5a\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"6838236474bc0640\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"1f824688f3e06586\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"38dc37a206ee3c94\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"1625381038d2cadf\",\"/knowledge-medium/src/context/block.js\":\"d02038f8a780b87b\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"cb0e634556acf88a\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"426ce3d32c0a0fe3\",\"/knowledge-medium/src/context/repo.js\":\"ea6bb6cf9210bb8c\",\"/knowledge-medium/src/data/aliasClaim.js\":\"7fc7f12cdc9b7efa\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"75167716f9177080\",\"/knowledge-medium/src/data/api/blockData.js\":\"d6058b6088b4a1dd\",\"/knowledge-medium/src/data/api/blockType.js\":\"22e2ab7b2627b96b\",\"/knowledge-medium/src/data/api/changeScope.js\":\"00e9f6698c3ca694\",\"/knowledge-medium/src/data/api/codecs.js\":\"9b0d49fa1d121216\",\"/knowledge-medium/src/data/api/derivedData.js\":\"940fdc182ff365cd\",\"/knowledge-medium/src/data/api/errors.js\":\"7b2bef0e956989c8\",\"/knowledge-medium/src/data/api/events.js\":\"acfb85ac9dd93369\",\"/knowledge-medium/src/data/api/handle.js\":\"67f26de762f38a76\",\"/knowledge-medium/src/data/api/index.js\":\"b71a1821d730b7c6\",\"/knowledge-medium/src/data/api/mutator.js\":\"453705ef62c7f569\",\"/knowledge-medium/src/data/api/processor.js\":\"f41bbb0b54f770ed\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"7bdf6e1ee0dcd602\",\"/knowledge-medium/src/data/api/query.js\":\"1e4f892b38716222\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"9464ca85b09eca90\",\"/knowledge-medium/src/data/api/schema.js\":\"67f26de762f38a76\",\"/knowledge-medium/src/data/api/tx.js\":\"67f26de762f38a76\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"f20945f9f812d2dc\",\"/knowledge-medium/src/data/api/user.js\":\"1ffaa0bd9401bd8c\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"cf95225cef55ad24\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"764a9c9cbefac623\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"7c590b6ed428faaf\",\"/knowledge-medium/src/data/block.js\":\"704303ccc0a0153d\",\"/knowledge-medium/src/data/blockCache.js\":\"ae5759b70ca2d4f5\",\"/knowledge-medium/src/data/blockId.js\":\"499754f87a8f9264\",\"/knowledge-medium/src/data/blockLiveness.js\":\"efc9a64f4df6bef4\",\"/knowledge-medium/src/data/blockMerge.js\":\"08b2b69e2bfeed75\",\"/knowledge-medium/src/data/blockSchema.js\":\"d83aef10d095fd2e\",\"/knowledge-medium/src/data/blockTypes.js\":\"42a1329b9f77aafc\",\"/knowledge-medium/src/data/clientContext.js\":\"de0ebb6e22a70dcd\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"29f2fbdfda8e924f\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"53f40ff0bf3db72f\",\"/knowledge-medium/src/data/derivedIds.js\":\"6161cbfc31820954\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"efdbf796d51a9c2f\",\"/knowledge-medium/src/data/facetBridge.js\":\"80a73af6668166db\",\"/knowledge-medium/src/data/facets.js\":\"008ad7da002a6000\",\"/knowledge-medium/src/data/globalState.js\":\"cb761eef7c4e32f4\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"56fde471d40075de\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"41e31106a01b9936\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"a3ee25ccb9f52a70\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"1448bc77cca99944\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"71a6bcb2b573fc4b\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"d6b1e337759557b8\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"d73d3041c96c9da6\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"59408173846fcf06\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"2acde74fa41caf24\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"40d3556c11215f03\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"733982c46d19c005\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"554485b3be27ba33\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"9958d92d34f23bf6\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"5b20e91990c7ddc1\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"3126f2081d52452b\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"459c196c303c0eed\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"11cb1f1174c0aad8\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"152c64ea59b05718\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"4162a9665bfcd2c1\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"6c43465f5f25fc36\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"a2a906f9fca60282\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"b9f229449541aef8\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"63771400089c1946\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"71edc3516dfed68b\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"119ecf439cb8f1f9\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"d04927ca0fba7fcc\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"1b3a4b47e885f65a\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"5f6b511f064744e6\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"5d91f769273108d1\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"52d9b3ab13598c63\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"35c817052d21d995\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"b886eeab1e1b52f4\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"b3d2a90c345650b7\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"a57afea13181591e\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4795ed08db45d277\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"c17d4de6a1a44710\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"d6811c5b21cf5646\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"2dcef4b9f6627f8b\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"db18933164a9a947\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"257d7fff838bba33\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"6e33bea013d31933\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"70c3e25905695053\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"235c3349b2eb8042\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"9c68062445612827\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"a2fa6be9e45d3261\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"7d5c91925b5480e9\",\"/knowledge-medium/src/data/invalidation.js\":\"26a03c08e74bcbba\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"080653c48264e2cc\",\"/knowledge-medium/src/data/kernelPage.js\":\"3cafe603d90518a1\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"30e69c455b699123\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"538dad135cee32d8\",\"/knowledge-medium/src/data/localDbStorage.js\":\"bced4f01abc531f5\",\"/knowledge-medium/src/data/localDbVfs.js\":\"15bfc8ae8cfabc7c\",\"/knowledge-medium/src/data/localSchema.js\":\"57afed81583f7117\",\"/knowledge-medium/src/data/maintenance.js\":\"7f7153860be030e3\",\"/knowledge-medium/src/data/mergeProperties.js\":\"d8060030a86c904d\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"a474fc7795d334fe\",\"/knowledge-medium/src/data/migrationsPage.js\":\"29f8f873a9720a67\",\"/knowledge-medium/src/data/mutators.js\":\"9e149d5107a53f46\",\"/knowledge-medium/src/data/orderKey.js\":\"df10e3622358f91f\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"18cd7dc89ef97e48\",\"/knowledge-medium/src/data/outlineSurface.js\":\"7614da0dfcac0ef2\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"8767eababafd569c\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"135e8ed82170a9d2\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"6cbd3ee26e26dfb8\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"b32df5d88c2291c5\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"aa28cd2f6033be12\",\"/knowledge-medium/src/data/properties.js\":\"f665e4d47abb8619\",\"/knowledge-medium/src/data/propertiesPage.js\":\"d064ce8709aa4bdf\",\"/knowledge-medium/src/data/propertyChildren.js\":\"2451bb2750f245c4\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"60de032fe080514e\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"2643315b9d99a47b\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"e4a55d7c04d197f1\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"a94256a7dfdc05c6\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"3a6ed749efb79f2d\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"7c2c4cdca98aa519\",\"/knowledge-medium/src/data/propertySeeds.js\":\"01a248827575b03e\",\"/knowledge-medium/src/data/recentsPage.js\":\"4ea301ed2727b40a\",\"/knowledge-medium/src/data/referenceBlock.js\":\"6bd9ef64e3264413\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"b44a6813174b875c\",\"/knowledge-medium/src/data/repo.js\":\"aeb4399027575961\",\"/knowledge-medium/src/data/repoProvider.js\":\"ea5eabbdab864e85\",\"/knowledge-medium/src/data/rowProperty.js\":\"682ecf63dfed58b2\",\"/knowledge-medium/src/data/searchFilter.js\":\"aabac9301c5caeb1\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"d78b53a5341990e2\",\"/knowledge-medium/src/data/stateBlocks.js\":\"994f84389ebf6f48\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"2c7c4948880eb88e\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"9faf05b5225245b0\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"17a6d184d0d79351\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"b99b11562f380214\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"a6ef16716d61c2e0\",\"/knowledge-medium/src/data/targets.js\":\"053e716d46e4a859\",\"/knowledge-medium/src/data/typeColors.js\":\"a9fae76fd86a0057\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"88991d1ce198a2c4\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"fa2ec0f3d4248e76\",\"/knowledge-medium/src/data/typeExtraction.js\":\"77fa50c8ca10e445\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"1185093d370143c6\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"432c327dfa9346de\",\"/knowledge-medium/src/data/typeSeeds.js\":\"66252a724281b818\",\"/knowledge-medium/src/data/typeTagger.js\":\"d473ee63d38bdd58\",\"/knowledge-medium/src/data/typedRecords.js\":\"0ddd9dbec96dd3bd\",\"/knowledge-medium/src/data/typesPage.js\":\"ea59e526b674fedf\",\"/knowledge-medium/src/data/userPrefs.js\":\"6b8570dece5c88a2\",\"/knowledge-medium/src/data/userSchemasService.js\":\"e69917a5019073ed\",\"/knowledge-medium/src/data/userTypesService.js\":\"86bd985af54bfc41\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"fced348a4c315b5d\",\"/knowledge-medium/src/data/visibleChildren.js\":\"9c27bd0dfed2e036\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"d0d06ce05dcaefbc\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"fedd1fe4ffb2802e\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"f0c7587230a815e9\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"081ceb4ad5ea1e8d\",\"/knowledge-medium/src/data/workspaces.js\":\"5f1536e8f318c110\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"db36466ee6f5234b\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"c4224081d43f46aa\",\"/knowledge-medium/src/editor/atTrigger.js\":\"73b315daa06778b6\",\"/knowledge-medium/src/editor/autocomplete.js\":\"be014cf94e496184\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"b86297a0bb68ccb0\",\"/knowledge-medium/src/editor/contentFlush.js\":\"a9d3052433827b2b\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"9f54b5521b0f77df\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"bf7a85260c9fcbd1\",\"/knowledge-medium/src/editor/insertImage.js\":\"8fce5b2b33e551c1\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"a61c3efe2011b7d1\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"c6e0cb7eaa70aca0\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"3f17c4860c65028f\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"9489306dc21b3896\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"bb563eddd12ecd51\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"203d27c83cf51a3b\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"954b46dbafe38b59\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"6d616dc8c625877a\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"d51dbd4ae3c864c0\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"7cfb8108ed35935e\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"b9ad27d735aece83\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"e840a3ee25c47190\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"85278e890d82c083\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"d9bfbf47e39319c9\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"3bd4ddbefe094ac9\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"b0d64b807fac7c54\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"1f7a95b0f6474a84\",\"/knowledge-medium/src/extensions/core.js\":\"547e8c122c60ad9d\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"209558b736c03708\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"1f6522e2eb180616\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"d895ea8c4d2d9cb3\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"56f04d17a3398e79\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"236a10bf7a1ef93e\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"96f4aa3ebcd502f7\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"576fc172b9ee8fc7\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"ebc50e7b69704934\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"372a1fa735bfe542\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"ea3fb4bc560317ac\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"4e914e69c1abec13\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"3965d1490a2b58a7\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"8c39f5ed70838301\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"f3d85168af1fa799\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"2517856313b44b3f\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"82cd023191853f8f\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"1738498cfdf62cad\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"cf5e68776e75ac29\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"b75cbc1addccb848\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"ea602f54fd4cf2fe\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"8c3d20ad55c3f1cb\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"a4890598330e8f29\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"9c005a5cc21bb086\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"2a07ff4d6d2f7a7c\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"aeae7ad32f4ed699\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"8d3b5af1e5786b02\",\"/knowledge-medium/src/facets/facet.js\":\"4b28c0b8b346c6eb\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"b062e953dde63f70\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"ad1fb30a35443277\",\"/knowledge-medium/src/facets/togglable.js\":\"fa7e7eb2946888fe\",\"/knowledge-medium/src/facets/variantFacet.js\":\"f08dadc377e2f2e0\",\"/knowledge-medium/src/facets/verbFacet.js\":\"6c31069434009fd6\",\"/knowledge-medium/src/hooks/block.js\":\"112a94bcbb718e42\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"921c898b9e9d0417\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"c61042c482618d2c\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"6a79fb3bdc3f665d\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"431c2c39c7a2ea0d\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"757483d1bb773e58\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"37f43c5ae692ccec\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"64a8c976f5f64a22\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"23fb3e39386dd3ed\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"81cd4049b627cc22\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"9fb109ce8aa074c6\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"0412db07059e5e65\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"38dcc577ec698a0e\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"c767ac32245c8aa8\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"3daa7eb9c5d172e6\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"20d3995bade2412f\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"75e62d24eb2e8ee9\",\"/knowledge-medium/src/lib/utils.js\":\"0198e08b2ab7b4dc\",\"/knowledge-medium/src/main.js\":\"24845b433942e260\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"89519225dee0c0a9\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"52c7d3af1fe8fe17\",\"/knowledge-medium/src/markdown/context.js\":\"455ce2fe8c5ea0e8\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"1f5b4afe5c0e0188\",\"/knowledge-medium/src/markdown/extensions.js\":\"c587cc37dca17ff4\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"24cfdd07c387d35d\",\"/knowledge-medium/src/minimal-editor.js\":\"6452316527cd5c03\",\"/knowledge-medium/src/paste/armedCut.js\":\"a537839576da43b7\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"45acb300bb47b022\",\"/knowledge-medium/src/paste/clipboard.js\":\"e9d6e271c9a5d446\",\"/knowledge-medium/src/paste/decision.js\":\"48ea76c9196f4dbc\",\"/knowledge-medium/src/paste/operations.js\":\"7c725dc47a25b057\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"3a0da65af8944a4e\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"b4c41fa3094d11b7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a056bd72a13d2cb3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"1baaad6d96a1f207\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"ad619a0ef4428e8b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f1cd8a52f61bdf83\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"f58b0fc8f1312c6a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"760453339dffd1a7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"21a3334ff99bbfa0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e219357049ac16aa\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"a00f115d5030f60a\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"68f4a0ca8f206776\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b1a5b403511837e7\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"8c45a0c7f88de6c9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"5e67c9974813575d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"949c8c30a05b662d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"5011694fc9accf2a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"afdd7e38e8b319ba\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"bed0ed34c5c6b50c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"a0ff254ee4a793d7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"239f20a698ef9f82\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"09b521cc1f594e57\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"4cf6c5ed972030be\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"04e8919aafd0e1fc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"f38006f826a815fb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"29ccae2f50d55528\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"af39a3b7083c00bc\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"8504dc3df5148564\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"c6d8d3b283010c77\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"72b695a819afe046\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"93fd0e7eeb30e4be\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"d8e7515b09b332d3\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"3b3898df9f76014a\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"ad5bf756b4797bfb\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"24940f8ebd84b6d0\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"b6067b9affe7e92a\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"62e144b0718fa6cb\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"718d15784c0ac09d\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"43454a00d24da0ef\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"a88cfed01731f251\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"fdd10cabb47d7506\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"52aea582d368376b\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"121f642be0b31f7f\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"18ecfbd6e6283f46\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"586f92566c53f45a\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"73707ec0cdddc6b7\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"160221bb4809110a\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"5a1facd57415a25d\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"2d51181e4135fcc6\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"b6aa4174a1b5a9f3\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"804887281c2a4ffc\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"e27f93d9c23e0065\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"52a88d0157d74b74\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"22cfbee764c8bc93\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"8e3f08ca7d34fe5a\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"7b8ec0c7351d3294\",\"/knowledge-medium/src/plugins/alias/index.js\":\"f59863f7ba2e32dc\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"8702af1dca1fd097\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"16392bc6f2f5c9b1\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"872239a46b2505e5\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"f8b4e157335e29e6\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"c5a9b3bae739f72e\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"92e68e8a7afa6e3a\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"d2b2959e4540c9d7\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"2326c2ecd0c21069\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"f463d60e920ad2d7\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"92a58f3bc9827cd3\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"436935029ffe1ae3\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"ce93a6b6da186892\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"9e98c26d9b30c928\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"8b92f84190159457\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"98fcd23be754a543\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"240aa1e1d64d13ce\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"f68320d094015853\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"a39ff6f49fb14265\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"dc57f70f4ac7e3fd\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"34a04c9ff74c9116\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"1e67905d5da3e17e\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"1d76ad139736a261\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"1baf2618d2493a4a\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"c8b2d1860a9e721a\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"7bf224a754722a42\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"f60fdc6ed4e6e599\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"1878095864875636\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"d2457a0e410f9bc1\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"2c327ef534809ab8\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"b7a46c25b9ae7b57\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"11eae8f269a033e0\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"99422192ab349bf2\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"3b22f74010a9a27f\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"6235d6811262f9d1\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"130d47e5b7435f21\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"167076dec49caf62\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"bbea202f6e197ba4\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"6cb6a0cda41308f9\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"3d399ea5fb9d9bdf\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"a9e5f2ee292eebac\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"94d2b0d2c354cde8\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"e764bcde6984d80a\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"53fe11da1416ff78\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"ca8695e58518c486\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"8f945bc33771da21\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"60e78fa82790c9c6\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"9a9957c1031a4fd0\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"495eef11a312933c\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"f4d9fa1525f406f7\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"48562e372eda440d\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"0d51544d40664406\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"b76e682d6b899ccf\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"de3c945d93122498\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"2da62310695d3f86\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"602bb187c2f2f990\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"020689a38359812a\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"521640889d666a45\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"8f272d086ef1222e\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"b6d0117810e68d71\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"94b3b7288b28a5e7\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"d4766c7c6dadeb95\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"7e67d6b63270f6ae\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"9de9b03b57743a47\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"d24335bc059382cb\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"131172b87bc074be\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"3b1bfa2efa7754bf\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"c44e5fee53891b5e\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"9d2a1d885fa70cac\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"0e6804da554fbcc5\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"3506f910bfc6f840\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"3b14dca882bb05b4\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"9ef1a2405f2be93d\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"04c3e77a7a7ce1d6\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"4203f6755ad1afc6\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"7768fceb018366c9\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"035a188480d36385\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"e04e489197f83985\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"60aae4dee954d3cd\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"35dc6384191747e7\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"708380149589df68\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"762eef4ec81466ff\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e4895b136982db88\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"c258a030d51967b8\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"576cc54c2b273bb6\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"12338d872be9c075\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"eca61e10b5d5ff1c\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"38d43a289dcd0676\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"bdc5de289ec6972e\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"e5db23efb5142383\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b0713c4fce7029d9\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"f5dc47efd3c124b1\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"b967a81941b1537c\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"cbbf8a80c14b8019\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"b21108629b48e647\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"b6211843151ebcd3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9248df801aa14f3e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"ab4970f53834e003\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"e87964a1ca90f8bf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b086f0c0b691348a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"5a925d3777a9c3dd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"44f4517fe2237926\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"ff652c933e6a4217\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"9d0a8d045c75b271\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"526aa73b1bfdc96e\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"0aed77b79eb2054d\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"afb3795cd060e7c7\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"8ed7447c5ca7161c\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"e76ab544c8a64737\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"7b2afced368e086e\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"9675e6b5afa5bc75\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"268b8c56c02c91c9\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"f2c7f0644d99e852\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"dc4b49137356a65b\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"2522762c31e9089a\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"e155e109861b088e\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"0a6d237da967ef69\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"7cba791d0a5cd3bd\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"b9d36d6cf5482e6b\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"ee6e99b45942698f\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"0f821834f0066257\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"bb5ec99c023420ee\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"f99c3cb837abef3f\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"b02c4d4daa4d465f\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a35a35f5d52a1af8\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"1094bba24d6f35bf\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"8670299b8071f4b3\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"38856fc2b9a86614\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"4b61ac7d143d10e5\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"a0262720b871115e\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"7d3b6fc086fc1fe3\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"514481b0dc715bc5\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"d70e8c3873f6c1f6\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"eefd2a23d27c743b\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9ddebae4ab07c399\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b524b71c3977865d\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f807bbdc55cd718f\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"101e3e1eadde0d30\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"a18f778420eeaccf\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"52ffd32cdf1d2d34\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2bc1d8f2d534774d\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"83cc10d78e4fd872\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"afea02d9b219d1b7\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"2d323a1d51685a76\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"e5a645e25f83e69c\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"6b0f71d1d96618a9\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"d1ee7fbef26f2ecd\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"58295b48269a24ab\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"90c58799cd291061\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"29143f2e990008c3\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"7308e8708649f328\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"4cd0204012e52e20\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"c5a700b5e24bfd9e\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"db6ffd37891e5d80\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"fad9070ec32f3822\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"6e47568b67df6949\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"518a3fdc6b2325e8\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"eae0bc5513bd6488\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"e1e67389e1139732\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"48d14d5d507cdd39\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"8318346dd7e60cf5\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"0c14515fc3ca76f1\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"db7416e3d728bb81\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"9578f275eeddded9\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"1b22a0ef3e1b0af5\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"0d2473ed68112bac\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"29e3b8992284b8bd\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"87f7322bd6124517\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7e9e51336df5ae82\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"e7e30f7b8c2a38bf\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"dfd39055dd188063\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"3fc8d3e9c4d4da22\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"754e7f9ce7ea4e7b\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"5375fa2223c20ad5\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"76f8ad5051505367\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"01e7c47ca3bc0532\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"620178b7ee7ffad9\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"8be2a5ef5f6f078b\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"79949b65247eea25\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"51f3ba57411ff273\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"96cf42e0f27cc607\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"4f0ea0ee68b722df\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"5356f871f6a85db5\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"54afd75b1affb997\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"cf2cd358e5144fda\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"8943840a3098fc20\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"c1df112fedc748bd\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"de9b123ec184f94b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"26d12ba6ca3a6c41\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"ff98b09264c4eccf\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"ed8b9c911cdb7aff\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"84d55a95ad211c0c\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"3eaf9cb04f8b9ab2\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"f4f0c927fe0bec08\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"6302adf0e616fc5a\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"781b0111f7675a3a\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"2e750efafd64705d\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"d4261ac0a3aa2c84\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"017c58d48783fb31\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"3443749d5b405fb8\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ac8a09cbf299484e\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3ab1ce3a37d69e06\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"6acadfc411ee07ed\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"6e774900e412cefa\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"32359563bd90acc7\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"ca9c53c70740c318\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"ca901fdd2339a75c\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"ae4cd89aa04e2352\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"514f2557f2600fc3\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"b0f5eff341b9a000\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"aa5aedaad923ba51\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"4ff45c4916d3b545\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"159146d6852f1fb8\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"10e10d012e179d45\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"3fd1628e23b5cd1e\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"e8af5635c65d3d71\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"74b8dc4e943fdb8c\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"90b744196f0d8d0a\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"aa6a3d8a5add13b7\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"08c930f495d4a80f\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"09c255361bcad93e\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"d793f84a26f4687b\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"2ee3c8bd24b5b77f\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"8e9a5f0c1d505d76\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"c72997a032c5286f\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"0befa85e383b8767\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"b3fa8798b86a24a6\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"ac2f2f2188ae68fd\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"d42dcba2fb86e1ce\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"565f22c3105a3b2c\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"415bfc6d24d7ae07\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"1d5acafc40668a2a\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"78b74652ab48e70f\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"ffdca1799900ef22\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"929d963b0c029071\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"d43b6ab19b772d20\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b1338ec91f44a9bc\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"4d1790c010d77790\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"084917681b907630\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"321fdf9b1ee0edaf\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"8efbff70be09509c\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"71b79b35994f2f74\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"24b02128e541749a\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"b2234d2315510a1d\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"ad55e62d78de8b5a\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"a7fe0cc6d97227fd\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"91f01155a9f304bc\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"59678029a5a945e8\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"9e5479107bc10a65\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"aef5cc296b4aa1d9\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"a3e79e5940cebbb4\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"9fa185ffb8061222\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"7948fa2ba421da39\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"b01de198d3085963\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"ee6cd04a7d352284\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"e549c30f0f04fa7b\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"63b687180c74f0ae\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"2d5b1323f36c398d\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"e7232e206c1bb8bc\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"28e97b505b5e3d1e\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"1353b7cb80c6a2d3\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"cfefcf58e2f415a3\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"9cc58360c868f1fb\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"14b6c6618d370d0f\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"81001b7afe59ef95\",\"/knowledge-medium/src/plugins/geo/index.js\":\"3557aa1075f12557\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"a8b85315ced73962\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"89d57a7655d319fa\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"f9580c89628be514\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"ff8dfc6a572eac20\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"e79ee2f025021ed7\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"44c07c0f9ae39df4\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"4c3060da0ba441a9\",\"/knowledge-medium/src/plugins/geo/query.js\":\"b78ba15bd71bdd71\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"6ede5278c02275e7\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f43dffc64cb4ecf0\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"199269c0bfdf4ef9\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9021d3e04ee4d236\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"c414498478305a22\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"98eeab9ba12224bc\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"f563e3264bf6b166\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"52b78885ad6afaa1\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"bf4a831277ab828f\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"66f4e3c1cc75f338\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"e427f79611b9efcd\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"5108b15af379f925\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"641f479355f995b2\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"66701bd1ce4c359a\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"95dd70ae7a82ae8e\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"87eac0abe22ca875\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"4643b27f79b5df1f\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"6f42240978c33020\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"cc5f0edea957e002\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"b964a8e4f9c73a4b\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"12db42ba811546ee\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"34c9d666ecfcd237\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"179067cd8aa43be6\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"dd1961d5f7a1f241\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"ba0d822c86f98edc\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"9827484a9fa8cc2f\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"95c3d5aa7cc69af8\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"862ec3420755ff2a\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"377e4bbc19000124\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"7723c6fcea544b76\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"a7804f4cc899a1d1\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"131d51830e251784\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"8461e1e17b4e3617\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"89c20761c3bf3824\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7a0d1392ba5cabb2\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"3e5f8e50b876e56a\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"75287ec3182ae3cb\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"41349bacd58878ca\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"04bed70be4d5d86a\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"2107508021015784\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"b4a612c95db09ffc\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"8f4f54b2e45b2b12\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"dccba17ee23b6fe3\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"d08c54f9c6aa17b0\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"51bdd6fa4bf608f9\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"ec33dff4da1d00a5\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"2357792692dacd1c\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"528e359f860d5284\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"b9b5316c86d1cef0\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"5529145a13a32eff\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"47f9aca93dc150e4\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"2a891bbd119ca749\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"0f8b5f6cb64a9b77\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"35e8659558be3b70\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"5a542f651f34ad22\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"be0612db7e96e48f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f37296c1b59a363b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"92e278892e5d227d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"0bb56eb5d50e5368\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c1e2648411095383\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ed1afd2d3ca573b2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"6992ce8ea991f148\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f8282976a796b391\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"3231ade4965aa235\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2cd5ca30037312ec\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ea674a84a6211b17\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"6a4d3dd5d0c3f730\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"198571edbc24cabf\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"55059f84efc46e8b\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"1f1edf7f35d99f18\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"88364b36b7b4c4e4\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"4eed3340f9a45764\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"c81693873686202a\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"1ed80b8c36b54b1d\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"9b19a737b404630a\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"c2eda8b9bbbde25c\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"e53e7b3bdde0b0f6\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"441ffbece05cc4d3\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"586dd54db1b94bf6\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"a521d3df654bdffb\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"cc7e9bd62fb43b94\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"fdb2d3c610f6c26e\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"2b541c791b7483f7\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"78e8d0445cb5dc6f\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"95d02c3d355ba340\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"6dcb32f366623400\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"facb25a95bee3788\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"cdd45f60f8af2282\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"c42d147a929e1648\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"a105d3781fd50af9\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"9fd47e1c72ee6256\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"9ee80b91afd107aa\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"a5488be829405b1a\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"440a0625c2ef2d57\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2119dae02ba64267\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"10cdd716e61a51c8\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"52ea17ed9dfae305\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"d47f5e2ccad693dd\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"eaa65fa8fbf8ba7a\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"c961ecb73b627c78\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"de18cc66286bf6ea\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"8097e88fbeadcd61\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"0e928bba0e191527\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"acb3b0b0878ea178\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"12eb629e52ab4f7d\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"2678633e99a62dcd\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"ecc23ccb91bf53dc\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"4e1e036273c024a9\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"1493a4d67cdd2cf5\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"4cff452419c72ff5\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"c4ab7097a52d0fe9\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"dc531d00396b8349\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"b55c742e43b6ad0b\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"b6848b8e56753ed4\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"e312b7df3fceddba\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"8f78d6464618cb3e\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"3cb4b314dabcad08\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"53c7177d7de5dd98\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"62c1b7c2a9f46b92\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"25a30f36f5002690\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"655397fc9121da88\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"57b6ef3e37d13bba\",\"/knowledge-medium/src/plugins/recents/index.js\":\"ab07d67a44197b53\",\"/knowledge-medium/src/plugins/recents/target.js\":\"7c785b73eb1bf1b7\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"29bcf44ae457ab96\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"4df44a96848dd3c1\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"070221315aa90524\",\"/knowledge-medium/src/plugins/references/index.js\":\"03ae2402347c349a\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"9c8448c1a37e8862\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"26bb2ced91bf9133\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"727a1665d5acf149\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"1751011f29977047\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"65c111281453e542\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"df7e092d3fb422b5\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"cb3da9d0de94b218\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"98f80195fbe589fa\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d16b087ff10cda40\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"16e86c2b36813597\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"12dd789bdb6d0693\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"088a688c45901100\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"e1e1e4cd235d05a4\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"ae21b91ca622c61b\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"01195065243c1926\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"f49c08dc000c2c33\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"d3348d7f971240ef\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"34ab55100d172f28\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"38082bc0b6d1c7f5\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"ed59da3f4c2910eb\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"870729670bb7c6d9\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0b969923c15b9591\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"c98e49277cc03b2b\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"8a872cecedd9be6c\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"4c439eb424285f04\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"092a5916afca3523\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"d137cd56ce68c00c\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"a4ab8d5e6a2083f4\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"4c57a03dc3c8c302\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"737eb02e65c23009\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"c30dcd5ff41e5ba4\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"8d44f5faef443f61\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"d5f1626985f72835\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"cde5a038ccad4473\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"a854eb23f6c01026\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"a6624defa9ca5fe0\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"c74b0ea1b1f7f165\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"e008335babcb0763\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"807c515568026159\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"269c6e6cf44b4673\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"c7fdad6edbc25f4f\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"17de1f207eaff2e4\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"4b04200b8e2755a3\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"658a2da54b49853b\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"f29207375c8307bd\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"7e8cc290d4d90a7b\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7270881fea230b9b\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"2206855eb771887e\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"bdacd902063bca10\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"420021d39f500e53\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"1df1bbac7c735d4c\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"736792c56d62ef39\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"2ddd3c2bf36eff70\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"066acb59c070d7cb\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"29dc0b6736a2fb8e\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"9839adc64cf87ddf\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"47fd50e9de87ba82\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"02c29fc07b20e9b0\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"19dd05f2006dd7c7\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c0a5c0f866deca1f\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"498d7353f52c0cc4\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"158f0218821b17fe\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"f40ce09dcf953688\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"e0c850240e980019\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2c4a6cb16d1578eb\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"8da8dcb11a575171\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"c173b12e7cf38256\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4b4f04d57f26eda2\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"15f620ea5b69cb57\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ea31080ed21c232f\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"821357d00a7d3ea9\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"9133ec58a9568a25\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"4fa2dedb9b23f31e\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"938d1ba124366eec\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"4d0da5e55c0c3d1a\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"e5c8b167d6e0d4fa\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"185bf45ad12c1a8c\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"3604a93d3b687b2c\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"c32723c5f5719b77\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"42db33a3bc58c5fc\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"73a06539c6ee9b29\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"83cda931a299f3e2\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"d6cdda9c556ba271\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"17feacccbd8a796e\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"2c3ebbc0f4213dcf\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"a357a36894d70d49\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"cf85be802441b385\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"f4191be508aa6bb8\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"eb402cd89d0569a6\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"07865f73358c763b\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"24c499fa9dc75254\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"9573f1ddfb89618d\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"ce925312a9b51550\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"3608bb4e64066ee3\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"095a9d4ed4b00abb\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"4aac47e5dc0c5a6b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ea163afe0bc93ba0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"d1bef1ba7b454bc7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"b295781bb6d7b03a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"86d12c0c00a4b7a1\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"2dd4c4ed4bd08dff\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"8146abd0c56fbe96\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"6819897625fa9669\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"f37d7f95a7aa8387\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"ebaf21a61fd09c22\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"2296dff3ce0c2ba0\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"224e7b42c2fc0457\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"6899e923ba993346\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"10406f363d42d9a9\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"7cd4d8f62b6a0e32\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"aeb8b1745fa5db91\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"dafe1aec3d8ee2f1\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"dbe4e58fa6210ab4\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"5628e1af50841157\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"83907bbb2dc9a26d\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"dc96657580d75051\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"a4838a5cb2d2e6d1\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"265fa41662d29d4a\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"f93834f0d4a01ac8\",\"/knowledge-medium/src/plugins/todo/index.js\":\"340cb3e95b8551ab\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"5fb042f26658bc80\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"bceffedf679620d4\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"eb9cede9253e2b4f\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"625de4c4b8771bfa\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"e23c903cb99684a6\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"386225740fd63d96\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"d321723f3298db51\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"d9dae408d1e82264\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"4f0e13010ab82851\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"06822b07e42bc215\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"b75b8d13e280c78a\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"77722cd4a663d53f\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"3ff358d2227f0438\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"d2b8f82c49e196e3\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"05ccf398001d73ab\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"69d50be7cb3910a6\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"d9576f692587c089\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"5134c58eaa104f86\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"09a338b5cbc91787\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"35125e75a3c840bc\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"f966f60f4a181c5e\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"46a05aea1aa46fe8\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"31fdcbac6a4de073\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"cd2c956a88dc9bf8\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"39b5350d675f2505\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"dc6c70894b8ad4cb\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"63e6cbce6caa67ae\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"387c6a10526aad2d\",\"/knowledge-medium/src/registerServiceWorker.js\":\"3a6d34ebdef6368d\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"9d9a0353a3189f38\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"ddd7d3469042ba91\",\"/knowledge-medium/src/services/powersync.js\":\"cb7b73b174d81059\",\"/knowledge-medium/src/services/supabase.js\":\"3913f56a508e9ac4\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"1a07447469022c43\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"8543172c3129c5f4\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"e555f74f79baa2e4\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"50ee8cbee19cb1fc\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"ccbc634551379e26\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"95a7245da7ab9b87\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"b83da79d208d4d9a\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"725b0b64098841e5\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"73815a84605fec8e\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"d788c4841feb231d\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"682bb74242b32697\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"b46ea858f12e4949\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"b06a2bf9b814e4f5\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"f4367dbca4a47031\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"6b59cd9ab9a6126f\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"6833079005b6aec4\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"6cfd47475ae64f0b\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"daddc75941ba88eb\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"9a1690d3a2db171a\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"38a02828b3d8c4af\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"4e7e061125edb709\",\"/knowledge-medium/src/shortcuts/types.js\":\"f7b2496449883ccb\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"87e2ee3d1a280a98\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"690c3be3941e418e\",\"/knowledge-medium/src/shortcuts/utils.js\":\"8297d51ddeebd066\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"c8e9fade3f473e78\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"719f8f0afc569ed0\",\"/knowledge-medium/src/sync/byteTransform.js\":\"582b8080531c652e\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"fabe085fb9b4111e\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"5c40a26684d76fa6\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"8e4c54934f756002\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"b434632f88799c96\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"555174d213f1dfd4\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"3fd1feb4768500d9\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"a6a2ae69b28bc6b4\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"13d6a978bb613a7a\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"f0ac06424cd34303\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"152557fb02404189\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"ded9bd47317d323e\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"19f6234f65b77ad5\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"7605c8f115cec8a0\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"ab538b01bfedd08b\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"ddc9ea1db08d7946\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"960487c3df067b17\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"9a678abdfa84c2a6\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"9098532ebc6f03df\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"556a5853bffdcf7e\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"82c298488c796715\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"f0e46677e62dcd84\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"e5d48cef684020f1\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"02304023a0d147de\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"060ed1e6f0ddfb06\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"df5d425fbe82b5fe\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"5e6240efd3720229\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"f7da8ad965ac9cdf\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"be466ddf03f6712c\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"a7bce9db94e25ef6\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"86f5395a6467eb7f\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"cea2c590c093f6ef\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"83df7216be4f994a\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"32c57db486258caa\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"59c1c40ed5e3b674\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"aa589aef1ef15a51\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"e8e8446a09b7d76c\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6ef5a213ccc90f54\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"03f8e421f9b68e13\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"d2ce08d530f9f5e4\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"091187bbade75a42\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"ce6b4f005ac4cb5f\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"528c0da5374a242b\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"60706efd4b3723a1\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"4d90620be6d3753e\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"fb70ca4b58143301\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"dcea08e3406b90d2\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"5d69816da841ea29\",\"/knowledge-medium/src/sync/transform.js\":\"01b0334d796c5a88\",\"/knowledge-medium/src/themeBootDefaults.js\":\"ecf8b72f046f07a1\",\"/knowledge-medium/src/types.js\":\"60042bef412b1366\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"bd7177108a1cf254\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"1ac9b6926b9e42eb\",\"/knowledge-medium/src/utils/array.js\":\"7b52b867770899e0\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"52bc167fd15fad2d\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"0275735637a49e9f\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"10bf160514e93012\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"5574ef5b6fbfbdd8\",\"/knowledge-medium/src/utils/callbackSet.js\":\"7a2945763a241594\",\"/knowledge-medium/src/utils/clientId.js\":\"8911baf112a9d7cd\",\"/knowledge-medium/src/utils/codemirror.js\":\"486b2d96676a849c\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"05bd61ddaf439f40\",\"/knowledge-medium/src/utils/copy.js\":\"8fb861d7006a1d21\",\"/knowledge-medium/src/utils/dailyPage.js\":\"0c87e4829625200d\",\"/knowledge-medium/src/utils/dbForensics.js\":\"60a8d5bb7eb8d53f\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"6e9d33b9002385d8\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"bc02e9d10358468b\",\"/knowledge-medium/src/utils/dialogs.js\":\"13bd88d08ed53547\",\"/knowledge-medium/src/utils/dom.js\":\"b15f76bf4a55f919\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"e336c79dd20b4759\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"261865eed3cc5cf1\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"56d42a7cb745b78b\",\"/knowledge-medium/src/utils/flipSlide.js\":\"f4be0acd3367e0e3\",\"/knowledge-medium/src/utils/fnv1a.js\":\"14b2f977646ed6ae\",\"/knowledge-medium/src/utils/formatBytes.js\":\"143401d27925f0cd\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"52c8cb00367ac6c7\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"0d69d6936726d5fe\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"c4e384aacc2ed512\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"92005bdb9fd72112\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"5552f93a5a0cad4f\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"9c24b280bec1c3d8\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"d349a9ba7c9e66bb\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"17c8d151f1af2cae\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"d0a81a74445b2c72\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"e4a25195b487190f\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"f5d0e135e30f4766\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"1e51e3d59b8f5935\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"89adf4781a3f2ead\",\"/knowledge-medium/src/utils/markdownParser.js\":\"213caebe0b94de56\",\"/knowledge-medium/src/utils/memoize.js\":\"b429526d9fad8385\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"ac9471a1e64c7de2\",\"/knowledge-medium/src/utils/nameList.js\":\"43c40f234456dfc8\",\"/knowledge-medium/src/utils/navigation.js\":\"7ed433697e1246b6\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"a26602495a94d36e\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"5cc9bac504bd62a6\",\"/knowledge-medium/src/utils/panelClearance.js\":\"2dca99d1c4d22550\",\"/knowledge-medium/src/utils/panelHistory.js\":\"e456263a5d8d656e\",\"/knowledge-medium/src/utils/panelLanes.js\":\"be04d2a8a1a2e4a3\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"944cafd5b1eef93a\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"0d874ee0230625b8\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"c5f8992b33e3b7aa\",\"/knowledge-medium/src/utils/platform.js\":\"c8b6c0945a4e001d\",\"/knowledge-medium/src/utils/pluralize.js\":\"d65e353caca8678e\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"02d02f4f07c69af8\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"b6c260b7ac7579d5\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"fa13195b2f32e5ae\",\"/knowledge-medium/src/utils/react.js\":\"94e5bc4704736594\",\"/knowledge-medium/src/utils/relativeDate.js\":\"171f4ec5754f4945\",\"/knowledge-medium/src/utils/relativeTime.js\":\"979b6735b5dcb173\",\"/knowledge-medium/src/utils/renderScope.js\":\"43376abb0fcff6c4\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"8026b55f1204a6f8\",\"/knowledge-medium/src/utils/routing.js\":\"5fffc37da2c82a89\",\"/knowledge-medium/src/utils/safeMode.js\":\"d7d5919ee5efabd0\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"89e942985335d6a3\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"ee3fa5394e7290f6\",\"/knowledge-medium/src/utils/selection.js\":\"7f5b7d5878b872a2\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"c82179b1b75b3491\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"843d906274a4d130\",\"/knowledge-medium/src/utils/state.js\":\"44d3f52879b17327\",\"/knowledge-medium/src/utils/string.js\":\"421f457faad20c69\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"352cff9752d99acf\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"6ef40379bacd66ee\",\"/knowledge-medium/src/utils/toast.js\":\"a128cfa54b21c544\",\"/knowledge-medium/src/utils/toggleStore.js\":\"6a385d86b20df765\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"ec2d7b319682a61e\",\"/knowledge-medium/src/utils/userActivity.js\":\"4e2f95af82415232\",\"/knowledge-medium/src/utils/viewTransition.js\":\"fb701527315adce8\",\"/knowledge-medium/src/utils/viewport.js\":\"2da1f444729418ab\",\"/knowledge-medium/src/utils/webLock.js\":\"ed14fc76a19b5b7a\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"f9a782c08bda0b3c\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"cfa6bfe766c67d19\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"f514732150e10a11\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"c0d35396cf7b0ee9\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"924d6e91ee935b83\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"3b58d222ead3c330\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"a437c11040e29781\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"63814273f6796c98\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"2f789eff1d9ecaf2\",\"/knowledge-medium/src/vendor/react-dom.js\":\"d2fdf79ba3ae6df5\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"1bd611de046fb7bc\",\"/knowledge-medium/src/vendor/react.js\":\"bbaf3c435b77a350\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
