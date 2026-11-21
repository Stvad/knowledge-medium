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
		buildId: "450b3ef4203d-23e12d00",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"64e74b8f59453291\",\"/knowledge-medium/index.html\":\"64e74b8f59453291\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-B_AkIzxA.js\":\"c320a3ca49de380e\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"03c68da259aacc91\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-Cl8UeKxk.js\":\"c757d572b0be437d\",\"/knowledge-medium/chunks/FacadeVFS-D1iAlJQs.js\":\"ab0c813613356918\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-CVMVfTUT.js\":\"1a06e2b74c0db59f\",\"/knowledge-medium/chunks/MemoryVFS-ET8BxZy4.js\":\"fb5ce7c08532f326\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-MpC_k2-X.js\":\"79f90fc55160d995\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DGN6xV3E.js\":\"7e690fb8571433e7\",\"/knowledge-medium/chunks/Preview-DDsUryiU.js\":\"ba8dd70045d1e2b6\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CWlbzO1q.js\":\"0b9374864f49d872\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-Ba_ejqMg.js\":\"725a260866e581fe\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B4_uK6O1.js\":\"33d21b47851e5c44\",\"/knowledge-medium/chunks/react-B5mWTG4N.js\":\"fe47ffd0a51d3fb7\",\"/knowledge-medium/chunks/react-BopH1OXq.js\":\"eac0715022b55bc1\",\"/knowledge-medium/chunks/react-CSEE5GId.js\":\"770f3cfd6618eed0\",\"/knowledge-medium/chunks/react-Ck4WMoEK.js\":\"07786cd761261abb\",\"/knowledge-medium/chunks/react-CmYOAYRW.js\":\"76f6a24fb2c73c37\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BT02M-sT.js\":\"bdcef6b83e00d141\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CJrLNKht.js\":\"9313669770bf227f\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BOC2ipz5.js\":\"e9563882ad4f9cfe\",\"/knowledge-medium/chunks/react-njewdz02.js\":\"b8e62d7a3c830536\",\"/knowledge-medium/chunks/react-otg2npYa.js\":\"e3b42c0b4c867522\",\"/knowledge-medium/chunks/server.browser-D-M1AVf4.js\":\"b8150e5d526fe097\",\"/knowledge-medium/chunks/textarea-Cgl9XRBl.js\":\"e356c79f6af2c59b\",\"/knowledge-medium/chunks/ui-BsU78D_t.js\":\"8573773796bac9f0\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"7e2019d4711ab95e\",\"/knowledge-medium/src/appUpdate.js\":\"eb50445c25c3b29e\",\"/knowledge-medium/src/appVersion.js\":\"2ce78136b0bca3d7\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"76bb5a1bac4bf7f2\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"d0c94b4080c5fd07\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"a6f96554ad42ece1\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"6cd57ed74f9fcc9b\",\"/knowledge-medium/src/components/BlockComponent.js\":\"8e77b6eec54e6557\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"9b83be8c8becd45c\",\"/knowledge-medium/src/components/BlockEditor.js\":\"b31805c2e957f06f\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"d85c43a7f599a840\",\"/knowledge-medium/src/components/BlockProperties.js\":\"6ffd317fb4cf2011\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"209a56f0aeb26d93\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"bc32339cededf66f\",\"/knowledge-medium/src/components/DividerHandle.js\":\"7fee81bcc37d7844\",\"/knowledge-medium/src/components/DraftEditor.js\":\"226da848fb945be6\",\"/knowledge-medium/src/components/GutterPill.js\":\"0c34fa2a8a89b0ba\",\"/knowledge-medium/src/components/Header.js\":\"54cd4e3c29c1af61\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"a0f6d15cb1c88aba\",\"/knowledge-medium/src/components/Login.js\":\"3600f3b5ef67174a\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"ba678f37d9178916\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"6fe3239bba5c6bda\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"eea95212823c39de\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d38dc9d4078c65ee\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"2ad623e7f3d89608\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"7d9d01ce33f5e23f\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"4816c299c2c3f890\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"6ec48167a4e971c7\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"4faa6d390d3a4b29\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"c19e2d1e77813cb8\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"0add92a1302f3204\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"18528f365fb7ad36\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"17da4a53d93d1150\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"ad3f128a7d72427a\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"600aa254d67920a8\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"e7cf272d7c5b42e5\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"b4dc439614d59eaf\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"42dd1778d5fef07a\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"818fa26360f63b4c\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"0f5c85b7f7b87fac\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"75a2bb0c00463365\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"ca99767fe3b11fc1\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"569d3309830f464e\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"c741a7353a6fab3c\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"bb2c4927ebb58068\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"2e441617a82de5e4\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"2e6277993deee62d\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"2bb2ae24589563b9\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"07590a9ce0b4d034\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"ceaa2469b25d091b\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"118f47bec7821de3\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"678f8e5a6ba086e2\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"931d077bf4bc1c14\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"96a7f2c95acc88d4\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"9ada493655760cc2\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"e48a2ac118f3cd24\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"f3dc0cfabec58bd1\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"beeb852b641f46fb\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"6db258131620c161\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"38fe8f641f1fb7a5\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"353043d8e9bb5faa\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"2aa0ea016ee13dad\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"cc95e2931e3dfea3\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"db005aaf0f9a5ea2\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"0e54f6c9c194ca32\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"7246cb2bfff4debe\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"18915c610d803eda\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b74f68107b7ac2bc\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"6867414023a4853e\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"03ddbb726a11eac6\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"d0306cbbea0bd51e\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"a6a9850907021303\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"217ec0a68052d1c2\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"b0f61b7c87edfbab\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"ac295d7f6d924c1c\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"0073649c1aa4661c\",\"/knowledge-medium/src/components/ui/button.js\":\"60a90520083eaa0a\",\"/knowledge-medium/src/components/ui/card.js\":\"5b85794236d0b222\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"f16d231eec62a7cd\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"6fbff9fb5dfb28ff\",\"/knowledge-medium/src/components/ui/command.js\":\"1ba5717fcb568b5d\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"929f3422475420b2\",\"/knowledge-medium/src/components/ui/dialog.js\":\"36bba9090e5e0381\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"51fb759b966b3ed6\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"7c413960f120068e\",\"/knowledge-medium/src/components/ui/index.js\":\"f8fbeb502950aeb3\",\"/knowledge-medium/src/components/ui/input.js\":\"d4f1c0aaa5ea35a6\",\"/knowledge-medium/src/components/ui/kbd.js\":\"fe479a46a73024b3\",\"/knowledge-medium/src/components/ui/label.js\":\"af9748ade18ff1c6\",\"/knowledge-medium/src/components/ui/textarea.js\":\"e0af71f7228a09b6\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"af1158a17874f18f\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"d73d8d5df370c372\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"b370dcecabdf65cc\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"70302a4d7cbe7f14\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"fcabfaed16d1647e\",\"/knowledge-medium/src/components/util/error.js\":\"a366199cea24dfbd\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"fe7c4672f8a2c3e1\",\"/knowledge-medium/src/components/util/suspense.js\":\"38141ff1202d146c\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"7aab661900090092\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"4657b8e65fa8d8a5\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"e838bfc9fb884fad\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"769575d872ffe718\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"ba6389db6a8ebfdd\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"1ddabb2604458573\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"fb7c1d1faf9cbffe\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"fcc735d864f2f69d\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"32153a820670d72d\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"366660f552d05186\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"a62a9e84b7c7ff9f\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"023c99c3bd735f6e\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d7a25a1a4cd08129\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"5bbcf03f3400116a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"0e5961896c98dcef\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"e36f961da6283ea0\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"bbc3063b494f3f96\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"bca0d1bdcdebb104\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"28118a8969cf385e\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"f0c06c0b8e6576f3\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"35c4d54d0a36f90d\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"358a232ca0b1b833\",\"/knowledge-medium/src/context/block.js\":\"d6a5a70d6a350add\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"2a2ea38d969c9d41\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"f71a7c04486044e5\",\"/knowledge-medium/src/context/repo.js\":\"7b2aa6c024cfd6f0\",\"/knowledge-medium/src/data/aliasClaim.js\":\"b838519691e2f042\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"6e7a2ab1a78b789a\",\"/knowledge-medium/src/data/api/blockData.js\":\"fd9493d0e776b59b\",\"/knowledge-medium/src/data/api/blockType.js\":\"96837aa131cbee83\",\"/knowledge-medium/src/data/api/changeScope.js\":\"521ef176c1224b57\",\"/knowledge-medium/src/data/api/codecs.js\":\"d9b89e9fd2716a05\",\"/knowledge-medium/src/data/api/derivedData.js\":\"e6dbb01556d424f8\",\"/knowledge-medium/src/data/api/errors.js\":\"b7d7c930ac536ae2\",\"/knowledge-medium/src/data/api/events.js\":\"8007d51082185283\",\"/knowledge-medium/src/data/api/handle.js\":\"79369585a117e511\",\"/knowledge-medium/src/data/api/index.js\":\"7dfc7a6327c410ae\",\"/knowledge-medium/src/data/api/mutator.js\":\"9607f594f66d31d7\",\"/knowledge-medium/src/data/api/processor.js\":\"389eb52f075bdf7d\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"0c8a6bbfc7b4dfbe\",\"/knowledge-medium/src/data/api/query.js\":\"de24c92d481ea4cc\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"294a8d26e9245caa\",\"/knowledge-medium/src/data/api/schema.js\":\"79369585a117e511\",\"/knowledge-medium/src/data/api/tx.js\":\"79369585a117e511\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"78bf9616afffa2fc\",\"/knowledge-medium/src/data/api/user.js\":\"75ecc6da6d0363b3\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"5a950082ca120cea\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"20155eab8beae473\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"14035fa51fed444f\",\"/knowledge-medium/src/data/block.js\":\"d09f2c28ed11dc8f\",\"/knowledge-medium/src/data/blockCache.js\":\"7eca58f6b1ebb0b1\",\"/knowledge-medium/src/data/blockId.js\":\"dbb32befc56e24d7\",\"/knowledge-medium/src/data/blockLiveness.js\":\"4af0985f32e11c1d\",\"/knowledge-medium/src/data/blockMerge.js\":\"f66ac114b2adbb35\",\"/knowledge-medium/src/data/blockSchema.js\":\"547050f8488eb5ce\",\"/knowledge-medium/src/data/blockTypes.js\":\"23feb6ec7b9a254e\",\"/knowledge-medium/src/data/clientContext.js\":\"53ecbb46370900e6\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"828a0af7cc5af244\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"90e4428cb571630b\",\"/knowledge-medium/src/data/derivedIds.js\":\"637f7f22af974652\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"f1b0119097d078fb\",\"/knowledge-medium/src/data/facetBridge.js\":\"ae1a7077bced53f8\",\"/knowledge-medium/src/data/facets.js\":\"c702b041d1f6a75f\",\"/knowledge-medium/src/data/globalState.js\":\"2f887abe05edc2a5\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"a3cc7f824e3176e0\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"74648fb12d4db460\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"b23c09be936bdb32\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"5a5dab657e8a5253\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"b1d887062edd2223\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"d72c2671b417f7b9\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"40b730a0a040ecc3\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"90bd98763af8419f\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"ae9a0ab95521d744\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"9e11afd86b3ee791\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"30ceb9ea6d4c2597\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"33fd881c76b09585\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"f36e848b54a215bb\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"a544283953f7916e\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"e3a4a12353fda8d6\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"4d6eda3c857700dc\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"ad036972ffc519b4\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"322c8424624275cc\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"8815d99181cf40d5\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"3ad56a0536fbe010\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"aad7b5e369890c6f\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"6abc47bf969a6ae7\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"4262426cf24a096f\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"813831007e51a87b\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"7f838cb7648536b4\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"bb787be690c9900d\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"fe1b3f1af4cc8cc8\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"76bbc4a5284c152b\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"e237a95dfaae3a9d\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"008ba994811bb325\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"e22899d68b12647c\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"700f46c4c716db7a\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"a3e98bceef2783a0\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"2a24237590a77dca\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"300e0f0ae6829601\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"d63a4f737ef95b0c\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3c58ec38b857a7c7\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"8516e60151fa1446\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"9a433c1c2714f0c7\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"094404f63a68f4eb\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"5b4a51c023069b43\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"b269a21ce39a400f\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"ccad86cb4604cb8a\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"87e217cce0a88924\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"344c2db93ac5cb1a\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"5c8d510bba6ea638\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"3a104cdb60ba1f75\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"f386519223e7ca7a\",\"/knowledge-medium/src/data/invalidation.js\":\"8c688432f79ef872\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"75b769a87c63a47f\",\"/knowledge-medium/src/data/kernelPage.js\":\"3b52d474059ff64a\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"a88e172f37608fb9\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"4e86109b2c705d81\",\"/knowledge-medium/src/data/localDbStorage.js\":\"13975fc2e81d06bc\",\"/knowledge-medium/src/data/localDbVfs.js\":\"6a61d513deb15ecc\",\"/knowledge-medium/src/data/localSchema.js\":\"502ab99ac55b8828\",\"/knowledge-medium/src/data/maintenance.js\":\"ccfcba10934e4e8c\",\"/knowledge-medium/src/data/mergeProperties.js\":\"f415ea8a0b05fb38\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"e1d02a22c1b4ee2c\",\"/knowledge-medium/src/data/migrationsPage.js\":\"b4b13472e20aff34\",\"/knowledge-medium/src/data/mutators.js\":\"573117e32db27ed7\",\"/knowledge-medium/src/data/orderKey.js\":\"3cdf6849369add17\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"c0a48a7f4c777ae5\",\"/knowledge-medium/src/data/outlineSurface.js\":\"a8f05e34cf5ff532\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"93650fc3e8259945\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"b4f6528f780d5898\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"99716831ccba77e1\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"f60efc83f1bf39cf\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"242b4ed5001c5978\",\"/knowledge-medium/src/data/properties.js\":\"20b35944f347dcf7\",\"/knowledge-medium/src/data/propertiesPage.js\":\"af84d37090e3babc\",\"/knowledge-medium/src/data/propertyChildren.js\":\"49d69294e4278a97\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"6c14e8077d59dde4\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"887b857d3432c29c\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"886211f03d58b1ba\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"94a1395b234b17ed\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"0dc15acf48bfb790\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"d29dacb3c3ef89d1\",\"/knowledge-medium/src/data/propertySeeds.js\":\"acda066a09ab10bb\",\"/knowledge-medium/src/data/recentsPage.js\":\"86d57e4e4ca88d8c\",\"/knowledge-medium/src/data/referenceBlock.js\":\"246eb47f4624aee1\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"462d7daf66be6647\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"47101cf196a25189\",\"/knowledge-medium/src/data/repo.js\":\"6df6937f8fa21f00\",\"/knowledge-medium/src/data/repoProvider.js\":\"f518344aa4060d77\",\"/knowledge-medium/src/data/rowProperty.js\":\"2f8fd1e922c072e3\",\"/knowledge-medium/src/data/searchFilter.js\":\"ffb257291bac0f6e\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"c5cf9b16c1e17bce\",\"/knowledge-medium/src/data/stateBlocks.js\":\"a4f97c593f507115\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"e4e78b2081b92b32\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"838ed5501c876971\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"e0347707dbf72644\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"2ea9425eb3052ea6\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"d4e5e9d9d069daf4\",\"/knowledge-medium/src/data/targets.js\":\"5a01a8d36d2585d2\",\"/knowledge-medium/src/data/typeColors.js\":\"11381f6f4ffde4bd\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"45cde8ce27ec5338\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"975590b6244dfbe7\",\"/knowledge-medium/src/data/typeExtraction.js\":\"f10a5e7e42316a40\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"9a6b0d1227ab2993\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"333618e88e890058\",\"/knowledge-medium/src/data/typeSeeds.js\":\"476ebd74c4a7d380\",\"/knowledge-medium/src/data/typeTagger.js\":\"4e492365b0fdd9b7\",\"/knowledge-medium/src/data/typedRecords.js\":\"25c936e748132e77\",\"/knowledge-medium/src/data/typesPage.js\":\"6a579eca5b3a0023\",\"/knowledge-medium/src/data/userPrefs.js\":\"a4efadbb887d070a\",\"/knowledge-medium/src/data/userSchemasService.js\":\"3ca3df74f5d9a082\",\"/knowledge-medium/src/data/userTypesService.js\":\"e229e4e025b3737c\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"f8f4245d949ab3b2\",\"/knowledge-medium/src/data/visibleChildren.js\":\"95ff50449df443f9\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"cdf9e86f163a6e11\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"81f9dfc3f55d0b8f\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"3c8de507d7041dcb\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"1c50b0b7687fe492\",\"/knowledge-medium/src/data/workspaces.js\":\"b653383f024095bd\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"185102e6e52a9a54\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"d5f7d096a328f7db\",\"/knowledge-medium/src/editor/atTrigger.js\":\"b280ced06e7b724f\",\"/knowledge-medium/src/editor/autocomplete.js\":\"13cd851178b4e088\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"f94a8f2aa1f22fd0\",\"/knowledge-medium/src/editor/contentFlush.js\":\"160309517862959e\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"4c3fc150238273b2\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"58e80cbe1060039d\",\"/knowledge-medium/src/editor/insertImage.js\":\"e273f19dbbdab8d9\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"19dad64cdd13699e\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"db72e2111267f8b4\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"a3e04b7226d9d872\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"4f5cff4ac54ee8c6\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"46aac496fe901ff6\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"7dbb40b4f413774f\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"38a6232e7aad3efc\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"987b2e52acc23896\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"434a1b71d6f0218e\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"c923531317befb7c\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"19a4521bdbceee6d\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"254c192905088a15\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"d749ed98677e44fa\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"4acdea3841141684\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"8655187e6a6b0c4b\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"a8f500101a1cf167\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"8f98ff75a5324b19\",\"/knowledge-medium/src/extensions/core.js\":\"d048f2a3295a920f\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"b6c8a2e1d4a8807c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"c3557a92bb393e8a\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"4991259e2c4bf0ff\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"85783573d5f952f3\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"538a45df95b7895a\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"cfb86f8196941ef8\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"d8253f4ce587955e\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"0cf7435e28a3cf9c\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"da62128bc319cc8f\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"b9245e74641e41de\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"2fd77c53fd7e32bf\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"714dff002b12e7cc\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"6bc67fdf48683c70\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"9be58e163703b655\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"ae4cfb3ed44ca034\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"b40f2f102a50da3f\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"c3a140231b5e2838\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"48e45d01056c1c5a\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"ec79a8cbcfe60f73\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"f346b757343ce10d\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"f234d2b787f653b9\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"91461b18ec6cbaa3\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"d7994f5f5618b5f4\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"aa679a8a33806541\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"dc24c85f26898fde\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"6d85d5b76c2b434b\",\"/knowledge-medium/src/facets/facet.js\":\"2428918715dda935\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"6c84cbe93d4a96ce\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"76e7eba13992cce4\",\"/knowledge-medium/src/facets/togglable.js\":\"8985914cb294e15f\",\"/knowledge-medium/src/facets/variantFacet.js\":\"3dc84150af78234f\",\"/knowledge-medium/src/facets/verbFacet.js\":\"0fb427987511349c\",\"/knowledge-medium/src/hooks/block.js\":\"7c841985e0d3d9dd\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"9c7433e1a4df4e88\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"01b95590f960b9a6\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"24b109caed2739e5\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"f52750840d2f3e2f\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"65bae85d8c0951f7\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"659d8277df9ae721\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"b24d6e82a7c86951\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"ee0d6fcd473ede84\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"3bf23d25ab9a158b\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"985542a6d6e60fbc\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"e23b43e970192728\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"aa5aeff60e64df33\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"2362411af83688fc\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"28b08a43d2500585\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"034ab0f68f090361\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"68318ae12939a2ef\",\"/knowledge-medium/src/lib/utils.js\":\"b8d7aef82cb66bc3\",\"/knowledge-medium/src/main.js\":\"caafe8fbbb4471a3\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"396c3b194beb043c\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"ee8ab1ec23f2228d\",\"/knowledge-medium/src/markdown/context.js\":\"0829da9b26929e5c\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"9a585ec27608024e\",\"/knowledge-medium/src/markdown/extensions.js\":\"074cbc709cf9bb48\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"4073685ce75c8dcd\",\"/knowledge-medium/src/minimal-editor.js\":\"b50105156104002b\",\"/knowledge-medium/src/paste/armedCut.js\":\"dc740dbf47db092c\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"c6ea31d5f3e7a0f1\",\"/knowledge-medium/src/paste/clipboard.js\":\"288f259a105bd66a\",\"/knowledge-medium/src/paste/decision.js\":\"25d81d94ad557524\",\"/knowledge-medium/src/paste/operations.js\":\"c859d1a662d4577f\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"896e579db7db1b49\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"6e3eb0e64b4d0c4c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1c470fc41e944dba\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"5c38ba184c99baa1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"d23eebc5fa1a8887\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"69341946977860dc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"0abbbe5a831aa2f5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7304f1ec96527d38\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"903de42b02b2b5c1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"432c52f6104a552a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"5113fd9c9e5968dd\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"db40530ee25d8501\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bb91b8364fecd659\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"299e8c77f0e1ee6f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d0cb547207e77049\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"56b78b715fcab12c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"f36136934d4709f2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1f49700d1fb32245\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"a49367d0f1f616e4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"5df576b3159ad99c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"e60b23ad5ec208bb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"2c126d5c4a424e35\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"9d8f7f78bf00a6ec\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"3ae664a2243d9f97\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"862c8de990fbb6d2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f8abe957ed66d750\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"7b321d8203184141\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"2d67438d0804b719\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"d98c3273a8281649\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"792df0f1a6a6e10b\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"4e8dd6f1ebbd51a9\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"2b540bdf0c3c488f\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"625b29f59f712d8c\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"ff5d8efe8fb7ab2a\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"4d680e7edccb4969\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"e0d03119636f0016\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"b0424f4452f9dc6e\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"97a715de89efe9b9\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"e51a9c68668bd996\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"b80427fbcb59bd5a\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"894ad92cedaf277f\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"f67247d55156a341\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"8928422377e3dc3e\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"af41a7e47cd3e389\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"f8ab809b6c659483\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"6991d38a30ad959d\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"b4ba98136e870947\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"fcdd58acc17fe85c\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"da6e63dee0c0432f\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"3baa8a9a04f8f2b3\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"7d9a2d2c34651d4d\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"3e5ec42570a072d0\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"85dd662da7e490ba\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"9db21904e5b0a5bc\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"14568e6f52c5df8a\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"797fc44822a0df76\",\"/knowledge-medium/src/plugins/alias/index.js\":\"ea5f7f48cbcfef70\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"772093aabd251fe4\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"c451e511f92bb81e\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"6122be355a357853\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"50f771dc819e1358\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"71a7a0e214308e07\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"1fd2b82371b2494c\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"9c258247d933cf77\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"2be07820146a90c8\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"828721929fda2791\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"0017d5af09211d3c\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"f2dc182c080b94ed\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"a0931e2f7a638b35\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"90a6dcbbd8b2b343\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"dfd20c2984b76532\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"8ca697640d29b516\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"cbd43e5819f94dce\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"2e200b55809fc37e\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"dae982e6a1790399\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"1218b8e9f7a06633\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"11b33a5519ff0022\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"2687669ebf7fa68d\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"5a6244b2d411b393\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"f00b732bf5bbb7d1\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"aad2b4642616197f\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"6b467e27e1e0f598\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"a06b9ef3ed628752\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"67adfb22fc598a27\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"d7510dcc497670c4\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"9109b1e788a218bc\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"b6c896158ac2f4a2\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"28a5db41aa05fbee\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"5023546783543332\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"eae97514bc522d3e\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"d1754ddba56971ee\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"b9c373f2d778c4b8\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"0461244417c45186\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"af60cd09c6e50ec8\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"2098f57bf169c27c\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"316dfe4e93a4db7c\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"1d3ba7bc0562f37a\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"9e5646cfcd4eb2de\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"164e433561dd0f8b\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"8375bec5d2c689b2\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"88046aeba7cf4b03\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"773ad66a95593f50\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"15666197921b711e\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"12c84d4dc218f012\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"1dee9b4a3282f020\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"601d158f3732b446\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"456de83ddc522256\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"3ac4684c8d5321a5\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"d088749a20453cde\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"ee77e8b1a669baf8\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"50fbd2f3b82970c1\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"646ef9c40d73120a\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"3675455c7d765235\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"4d480739873fd4ca\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"9469e9d8f2156b97\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"1e7ee0b0d27026fb\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"9b20d1809b6d5169\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"226a40c79bbd4a53\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"46f9556b65c46d02\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"0679bd05d3b99f54\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"afff666fa85f62c5\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"55943c8831eee0d1\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"5750b0fad56fba17\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"7da6f8777fb886a7\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"3609fce7b806e6cf\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"cea66f4f146350cf\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"43d66a4e7960e285\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"0d9d7ade7ce92fad\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"fc5b6ff6d28155fa\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"de1ba1d2a5b59448\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"3a40deb93d4ef46b\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"7f0103d0c17e9872\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"621b3a8466ae7fc8\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"82989cdc6594c84b\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"c9cfc889a7adc900\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"76971dae10f9b3ee\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"00951ede6edbc30f\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cd0df8614410e8dc\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e4d57075dd94e4dc\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"cc044f187c0cc667\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"b941eeed0f8cdb56\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"b862331561c1ed3f\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"d2917d56f6510a33\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e94fd5d543ab8c8d\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"168f652cb6f80a76\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"54c4fccac398adee\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"83d3c15cee7c13be\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"33099a694e298df0\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"e60f63b7f60ec003\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"0ce59b75c04d4e28\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"01e7cd80c6d36643\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"213fe38e3a2a1452\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"97e5ceff42c7ddce\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"b04013e40395d8fd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"33b939d9e6968c7b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ea9e245544ed612d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"7aade809daf67a78\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9a6a8a8bc6f99987\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"f682feacfd6c2fc4\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"5db6017a40c9dad1\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"ef2670a0c222a768\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"eac371b95769bf80\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"38a812e8462baac6\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"486d257c898ffa8a\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"7b60700709e08a8e\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"3df3b27b609d492f\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7613ea83ce00b904\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"56312f4ac8ee8bd6\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"a1b525b2a11da667\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"8b31201070f330f1\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"e49a6d16d17ad33b\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"c88b708ee78ecdbe\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"2a24f1a9781603ab\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"806f004dfa452b02\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"059e3ef21699c1df\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"17356090e65b2a98\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"046339c72216cc32\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"6213dc5aa80f6243\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"1fc768a85d02b93f\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"f07faaa98ac64ac9\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b6559c16843b155c\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"b53de241b1a986bb\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"3987bc223a3b3e03\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"179c1f7f41c6971d\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"400843f5a6211273\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"a8e3c07b56a9914b\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"52b94d300e00210c\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"6c88c53edf3298cb\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"04acd74405eb34c6\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"75fcb4a40b0d554d\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4c3e2503fc5d63ce\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"163329241163eced\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ca960cb0830e1f90\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"3b541fdc38991f36\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"97108daa8d3a291e\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"410a971458d5d0c1\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ffcb5c4d0e94835e\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"707c04e05c0c6fad\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"fb066cb9d849a4d2\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"6dd43d8ff4d9bca9\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"11fd57f8a51a5318\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"058d8c96194af9b7\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"033c06c6579282a2\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"1bc48046e1551c52\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"33611d569b19c7ef\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"27b4cd500cea2739\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"62382dcb18d697c7\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"e95f39522de1883c\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"14c67df5b9df5b4c\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"287d5723163e139d\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"7e75b93da8f45c31\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"2ac93ee2c5bbc6d1\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"521a82557fda1851\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"11a152cf18001145\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"6a79c10230c9f497\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"5906ca0e5665d576\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"b0721ebc763ef7f4\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"8ee32c4d84fb4e36\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"be41e972ac988250\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"0d73a66bcb905be9\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"eae7e2a1968c2d27\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"1c694f7b4d6883d2\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"fe592a5b5e020a0f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"875cc42a79fa200e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6b2f9812845f068f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"0c3cfbfc40962b8c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1120bbd28f76e965\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"97581d47f1ab9f61\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"fdce3b29d5e9b668\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"d0d0994debc3ea2f\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c0ca2009f0a95a62\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"9ad40a422cb471f5\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"d01d070a4ff4e03e\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"51143892ec6df44d\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"75db286080b4fd9b\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5af085cbfd950a03\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"b64e52b38dbafb0c\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"67cbe376bc6367f7\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"5ba52c8a33b32fd5\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"cdb789d2a7b5d84e\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"fae8e7f202bf4e9f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"13e0634c63a6b484\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"8b49f574b076af63\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e5700784778161bb\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ac735afddbfc2da1\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"c3b35cfca892a3d1\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"46068995bb2300bb\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"5c0d5511cb422e51\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"85fdb11e52000833\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"2b663270caa53465\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"389b1fbeaa049f43\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"0de32ee27826e983\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"af195f504272bd05\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"ba7d0839a8dea71f\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"0f011992be5d54d5\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"78b78f07c463ace8\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"843a6a75b62fdff2\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e267cb125bdf70de\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"84a0171316f144a7\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"e02cdeda477c8a46\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"81a20ed4ce312a37\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"4e277d98a797710d\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"e44521d296b9c30e\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"def9213d52bf9f42\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7b659aec7ad27a9f\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"8e76e3532d452347\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"66eb75117be977de\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"f547d3ba540ad759\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"92283cf56f379e4b\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"2d3800a40893af19\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"b1b6f553a7c6a1c5\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"f86cbd631650dde4\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6a62a72cd9b228eb\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"43ae95a08f442f01\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"00614dfe84c2b65c\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"9cdd18ded90d591f\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"954b8540de033da8\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"dd162582b8f1497d\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"86443a9ad101deb6\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"7f9eee3aa7a75b3e\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"0273b3800562a170\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"4ca3bc9ae20cda3d\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"72bf268242d96545\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"411dd365ced1be7b\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"4add60daeb31a933\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"d4c3e38e36920b11\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"4ed854738c86c93a\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"5c61adbfd468e600\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"5094ff9216b7a623\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"8c4b45878c1d2e3d\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"a2b2f9967a7959a5\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"dd4d48cf65c79dda\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"80ae9e0e957959d3\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c1bce84cdef1c664\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"b6f1984a60f7e36b\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"17f7d7298efd3211\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"95f764716df4499a\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"24e8e98dce535295\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"52f03168528e0246\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"74dcec31dd568446\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"5c68a298e10ec988\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"2f98a6cabc620fb0\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5f57d96c49705588\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"79d4f886cfc8226c\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"56c0291f83ba56f9\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"79e2c3d7584a80d5\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"3f1ab0c97967d7c1\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"78e212c8b321e101\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"7a3d0fd5973b9176\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"f37938f22c7951f5\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"d81eb219dfe5bfd2\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"efe6a20d916db0e5\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"29187239c71d1245\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"a0cae560514bf66a\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"bbb038328bc4d5f9\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"9aa96d6731211386\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"78846d51737c0314\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"3916e79a5f97c22e\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"6b1d2fbda77ea023\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"78d47ec2bb2e7608\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"840f1f751449cbeb\",\"/knowledge-medium/src/plugins/geo/index.js\":\"379bac17a1b76c1f\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"fa16a93ba331cabb\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"4320d4929012204b\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"2e58a665a03b0ded\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"d4127b820cae5f70\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"1d4626625fae34e0\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"8ccc552f039d49d2\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"74f19a3d1f1d8423\",\"/knowledge-medium/src/plugins/geo/query.js\":\"65292980c0487bad\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"81f4542a084d9063\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9cbbd15af8b61cc5\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d211cb9aae5ff12f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3c21d42477deec9c\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"9f5cfb8064300092\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"6717a773441ac4c2\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"0ce4c719b76834a3\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"bcfbd1c4fdbe7165\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"0d0ba1689c87f211\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"37a93d3ce90b6661\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"2ad8358794546347\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"8506f01a4dee05ab\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"58a098817a683f57\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"0aa9389299a08403\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"2de4fde0a237e024\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"d19dd9117acef7af\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"bf3988a1dcfee06e\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"7317a665a21a7d55\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"9f54c8846ebd96d1\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"ad1fd1ce0c9194d7\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"fc4dd647aff86a1a\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"b9413aa24fffc75c\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"6a01f3c030ece2bc\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"44bf0b15bc3d7bb9\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"2cc07ddb699397ab\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"955ff98a0b695e44\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"69e2400989439344\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"7185b39a03424658\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"129fcbc93ec1287d\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"c7a203ac03a73735\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"2e0f655735d60633\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"8e4caebba64f708e\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"ef7a14096f6cd277\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"98b26c2305f0b7d1\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d970da2d4d208890\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"7f556fa537482e8c\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"a9ac4d42c2dcb3bd\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"6ca860ae2ab1a9a6\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"189c610c3d5ad084\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"54d3ce1a8297d92f\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"29bd2282eef9456d\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"52b56e5bd22db708\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"27fce53ffbd7b249\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"d0d8391dd6ac9abc\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"444f5dc98949d27b\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"362f81319af897b3\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"3ef85e1db0f6bfb4\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"9a2522dd798ca171\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"7e6b9cc7960de2ee\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"8d6ea4640d8a7e35\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"eb41d8a82cf08a16\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"930547ac4814f9c5\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"1f02974e341ada73\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"9585c6c8665c7d2d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"4881e3738afbb482\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"bc8d95143525c57e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"c6f34bf861b9cef0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"c3a9e5e8d7f3e099\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"e1f72fa494a1b394\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"2bbc97740e063526\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"526bbda9d1835272\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"21a4574aff2beadb\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c110ea08cbb1826b\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"616372869b446639\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"fb3652ad1472ecb4\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"62bffad8e85e2cb3\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"4f1ab1a3f3a8a275\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"6638d359d3778dda\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"01245b2550a6a796\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"056ec42c28e7ff47\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"0997447f6f34b0eb\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"4754161023836c98\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"45facfc455990287\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"01821b436603a478\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"c5ccc0a9a12445c2\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"f0dfe64742275200\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"97ff8f97e9b5a4ae\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"8e86df1a2c92c970\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"d57b37a28f6d1b5d\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"8683e9a25601ebe1\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"d20ebbc0ac368baa\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"b8ef70fc1fc749a5\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"1719520b61290b18\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"3b9bdbb6b480bf29\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"09578bc97e161a74\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"435af7090dc2a152\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"9f0e955710251332\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"67fb436df15ee4ba\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"b289e834d761d3a8\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"45d7c024de4d9ea2\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"fb51636bc3587c9d\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"063f6b6a25025b8f\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"731d30bd1f5fa279\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"0824844d03cb2bbc\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3a1bfc7703ea91c4\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"5de13c32f8b6d2cd\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"3d368808705bfc33\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"befc22ce820a1855\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"dbeebdfa1a2e9b0d\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"72b1eeedf989c4f7\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"4732c23811e1c3d7\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"b50820ab0880d912\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"2ca24ac1157a3697\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"cbe5ec825a0ef7ec\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"32717ba945ae08f2\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"c526b388f5a5ed68\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"7aa4ee62fa9ef46c\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"5e49c5499eac820e\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"0bdca8a222c26c86\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"5da817ade4969c1a\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"06c6d10744b9b4ff\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"350b23c10814f91c\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"4041a20f6b2cf48b\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"60c0786e94914cd8\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"2fde1ff5c674f50d\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"1953df16c501861b\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"26adbd867693af04\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"be4c3b13a6efb370\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"ed4648f9cdc22fce\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"b7070c37cec3acf7\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"086f75e984b38765\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"56e22794ee655213\",\"/knowledge-medium/src/plugins/recents/index.js\":\"c271f026991ef162\",\"/knowledge-medium/src/plugins/recents/target.js\":\"7ca4c60955b0d863\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"40bede585015fec3\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"0322b9182d7cc893\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"a1d6e6cdf41f58e7\",\"/knowledge-medium/src/plugins/references/index.js\":\"3cecab8e451b2ed5\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8ee88f1d2657eb1d\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"b6ebd148e14ed3a4\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"510b01b146a6f8f9\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"06ca62c3d3ad4113\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"c064d599fdf2c651\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"d7b20e521eafba03\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"89f2182bf46fffb4\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"372bea7d96a24d8e\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"35ca0b1cac105047\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"93196a2934207477\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f4dd93e1f22208e5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"bbd97dca1979d7ac\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"95d7922a00615bcd\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"08b2e425d3bf8a75\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"7165bc448e7cbfec\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"2546b86131420c8a\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"8a288a6688930332\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"95d2588c66f05222\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"93f89d14baa3117b\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"f714bcad96a04646\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"168d8c5d1a1745e6\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f22f0dca2308510a\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"1e7112b836321383\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"1dd5a6bdfe03c475\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"3328d864d0c088f2\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"68e176e819d354ba\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"2c2c8a37243d409e\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"9283d4074bbc3273\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"81d6c37b191b79fa\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"164969e6c59b81e5\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"0678da79a53c17a6\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"d0bcd0309589e3b3\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"5c96acd2f4c7feac\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"b2346f974dae4a3c\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"3013829527359c01\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"12e2ae112b1aa288\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"0f6760aa8709532f\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"c24842cea667c8df\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"443ee81be90b067f\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"a329011e9460f440\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"dff6a4e3457b8c2f\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"00513fde69f07c57\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"a9f5a3b572c0721e\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"9d62ca3cbbea2c06\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"a6578df81d068a19\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"33d87e7b3310fc42\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"76a22bd191dccbbb\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"925a097cfe36e59c\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"eea5e38337edb490\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"b3126fc6826955eb\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"463903210a86f0e0\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"9ba7486952551511\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"10f1c0509f4f1c12\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"ceb4b109b8d1dbc1\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"6257297655937306\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"77fd24aed2247cba\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"859742dfb037b6c4\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"4852cb3c5af2dbaa\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"f35400da44c9e045\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5ac97617612afc30\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"663de57d3ce9b34a\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"84b9fe3225b1ace5\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"9972b467f34c45cb\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"1fba22759e9ba92d\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"617a9da09f4c52a7\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"b61a38b086826c8b\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"38244d0856aa5c69\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9ab4e7f9f2904a87\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"c77628995ab654f7\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5efe8b9c88611467\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6e8bcfd2858cf4b2\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"3c044ddc061081d4\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"6426b7934fbf3d90\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"5d4bc7295e8e27bd\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"0c029b3a5a8f90df\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"024df8bfb9502af3\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"a3c31514be3c2304\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"f696700a88a9b358\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"806f69d4a90821fe\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"a0141f64b2faf7cd\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"58f9c96650fd861d\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"5e16e449ccd9e453\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"e9b13676f50d802a\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"3a3c2c607a0b5696\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"584a79912d552743\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"6ab1740a9a6ebc34\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"4627d59b6904ca9e\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"08a0b9f960b08676\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"7c2530732ef166f4\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"e3c49375af7a0918\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"13b55d7d51dd9b17\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"2ec16772474feae5\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"9ded2f8c192165dd\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"54f807d022b1caaa\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"970298bc46502654\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"d8f83a2196e40e2a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"02cbdc6c308a2915\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"0237e6aabf40285c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"4cb089d571456692\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"4d59ffc4ddcf0ab2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"d03434728c1bc5b4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"d46bbc365f5a586b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"4f3c69b738c7c612\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"58caf96e6e0b5c29\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"7034a7db4ba1fe66\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"0d6964cd0c624f52\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"9ff2ed6e13796052\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ea1cf11b8ef18e1a\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"e5361e40ac31c10c\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"80c4b095980c2d02\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"c8873b57cba06cf0\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"bbc9a5d8e39651a3\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"a45e17b66cdcc7e9\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"32a2067b2ad62bf1\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"59fe3c14407423b3\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"189e46ba2ecfda80\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"0683da633133af55\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"fb20be818f924d9d\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"99bb12f5b4a5d174\",\"/knowledge-medium/src/plugins/todo/index.js\":\"29bca19b23035959\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"3442e1ffe1d59ee8\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e2d51f05f155c2c6\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"a717e13c783dc711\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"ec90b7ce79c616c2\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"d0f8b3aeb4d4bd40\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"babd4f00510b6657\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"9301fbdb5ae3089e\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"dfa3b1f4dfb65758\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"116331c6a6e894f3\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"69dd1aff4bed1a9d\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"c9c902fccf180ee1\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"90f311386200655a\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"78b9220337aa35f2\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"b7fd4f77255f3ee7\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"0b46536f2e65701e\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"a9a1da787168009a\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"b48685ca3d84213b\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"3c0b16d765cce132\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"dc5a3fb9ddea03be\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"8a9964227612c8c1\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"8ca7b6ee51173b6c\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"e313c3bfc4502636\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"46fd1a42e0700f43\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"97eeb585882336fc\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"d1a8d5b7d1b94238\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"b7510762c9a7449e\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"005728df4d4768de\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"24625c02a4e4d581\",\"/knowledge-medium/src/registerServiceWorker.js\":\"2d3cc7c47682583d\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"8ebfc01e9a377fcf\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"d9143d97743337bc\",\"/knowledge-medium/src/services/authStorage.js\":\"63603498e11fe1e5\",\"/knowledge-medium/src/services/powersync.js\":\"55171e2edb182388\",\"/knowledge-medium/src/services/supabase.js\":\"6a77063473e0bf48\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"4df7946ba62f129b\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"ddafee0d67dc912e\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"424713f5b490d8bf\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"05b190f0029fac1c\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"e96b1663663391bf\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"d013c54f522cb437\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"47ceee65a64561bf\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"d19a198aafb64a0a\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"8fa38996aa84ce21\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"5ff3aa4548012392\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"107ac90005eef1a3\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"59105f1a06e265e5\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"5553cdff2ac595e9\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"9451001e38b9564e\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"dbf4b3e6113ba246\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"bf20b233edbecf35\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"b884f90afd3519bf\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"01bb4d801233355f\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"d0ca1601d14ef6df\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"70b8a1cd4af4853c\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"177d21b3c73c2205\",\"/knowledge-medium/src/shortcuts/types.js\":\"530b3f6047502e83\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"23a5f86015979f69\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"8a786eebc999a56a\",\"/knowledge-medium/src/shortcuts/utils.js\":\"e63b555f8897e257\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"05bc4df0ac81a815\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"4dd8b6e9cafda899\",\"/knowledge-medium/src/sync/byteTransform.js\":\"3499ba674bc4f65a\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"65f8a605157b07eb\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"45dfc7609c9270b9\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"366cc19528b2eece\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"da01b8c2e2805bf9\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"453b29b2d039d644\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"95e975029792b277\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"5bdca08b7e78ad68\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"3d061b06168bf0b3\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"eebd7d6094981d7e\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"4c22140829884c07\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"a0bb1eb24b1173e1\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"b1c384ba1598ae4b\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"238b525bf8642949\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"2db3074b5d7ea423\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"fc6502dbaf3f0bd0\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"57b805ebe0388789\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"5afa30bd6e8fc1e4\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"cac0037e976d7e26\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"ea2e4f9fa2f46fa7\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"97dad63c398a18ea\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"178a91f92938453c\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"040c40d4fa4d380f\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"3d0176838800d213\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"69a3bc8c668d163b\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"f1161c0ea85ebe5f\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"74648f28fa6a4c97\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"8784ab2286662445\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"cedcd4bfdb9436d5\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"611fbf578d44cfeb\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"0623383404526b56\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"cf2829269bddd77e\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"d3373700c60947c8\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"e542c1fda15d6405\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"c1149c723a8c1068\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"35814f9075460200\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"00295cd331ae0881\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bcf4b2079494149e\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"6434d52cfd7f6716\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9794187e8f9b17ad\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"bcb4e02ec4a943ad\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"ed547f5663182bd9\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"0a668954ae8f0d7e\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"b5ef184101cc62bc\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"58e37c741c04b782\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"7bafa6be7b17d752\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"f4b694d435260b27\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"a577bb9160091f2f\",\"/knowledge-medium/src/sync/transform.js\":\"7c4f20879dd58c97\",\"/knowledge-medium/src/themeBootDefaults.js\":\"3366b5ed9e9f00ab\",\"/knowledge-medium/src/types.js\":\"e5fc5fa03721d565\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"8c1bc6e485d012db\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"9cff4c453dd095d4\",\"/knowledge-medium/src/utils/array.js\":\"52b55cf407eab7b4\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"c06fd119dcb2e323\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"47cb0ef44946de72\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"1bcf1a486e93a854\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"f91dc9fce9f2b50a\",\"/knowledge-medium/src/utils/callbackSet.js\":\"65c811c9249abb27\",\"/knowledge-medium/src/utils/clientId.js\":\"2e986804c4e0a1ec\",\"/knowledge-medium/src/utils/codemirror.js\":\"f2b437afb641ea01\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"f60077b5edc3bcfb\",\"/knowledge-medium/src/utils/copy.js\":\"a02e6905679de29b\",\"/knowledge-medium/src/utils/dailyPage.js\":\"bb3beb92b851dd02\",\"/knowledge-medium/src/utils/dbForensics.js\":\"db7ddc5840c0ce5e\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"3f61f23f7af96ffb\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"0efcbbf2d6e9a6ca\",\"/knowledge-medium/src/utils/dialogs.js\":\"2e588df7a077665a\",\"/knowledge-medium/src/utils/dom.js\":\"a4afd3d9eca98321\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"1d54f74268d99b59\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"208f95b74717c69a\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"672da50d86381fce\",\"/knowledge-medium/src/utils/flipSlide.js\":\"ae3986517a12ef5d\",\"/knowledge-medium/src/utils/fnv1a.js\":\"47fd2626d1c2eb0e\",\"/knowledge-medium/src/utils/formatBytes.js\":\"03d24aa043573ba0\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"f8bd274a0c9e819b\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"5576a3a0401c1e6a\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"b8b492a1cf3b060d\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"4efb19bacae69c32\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"d8a9811779f37411\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"0dc5a1a1c62501ae\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"d3d183775d0b006c\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"740c6b911b2af63e\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"a0b2cafad59bd834\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"7794f96dfd5936d9\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"e2a4b040a0eb8703\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"c7d10980da78949c\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"a18ca772583a162e\",\"/knowledge-medium/src/utils/markdownParser.js\":\"da3de7c3225420a3\",\"/knowledge-medium/src/utils/memoize.js\":\"276ec7a3f7145561\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"ca4fff4876ad8e7b\",\"/knowledge-medium/src/utils/nameList.js\":\"a7d7188db0601cd3\",\"/knowledge-medium/src/utils/navigation.js\":\"a1b9656ad528f167\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"2f31d4f77c31357a\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"a414adf81acfde5a\",\"/knowledge-medium/src/utils/panelClearance.js\":\"485c2922d5fb7ea0\",\"/knowledge-medium/src/utils/panelHistory.js\":\"9573951a3c6fbc31\",\"/knowledge-medium/src/utils/panelLanes.js\":\"c83507fe35dc865c\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"66c26f1580e9bd42\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"f5709acd4170d64b\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"b516a02ad754904a\",\"/knowledge-medium/src/utils/platform.js\":\"5819901b6bd03d2d\",\"/knowledge-medium/src/utils/pluralize.js\":\"821421e010659793\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"6825b4f841d74b0a\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"4100f99831f30ba0\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"b6a5db856133d58a\",\"/knowledge-medium/src/utils/react.js\":\"c065336aea30cdd5\",\"/knowledge-medium/src/utils/relativeDate.js\":\"346df9b1dc502b20\",\"/knowledge-medium/src/utils/relativeTime.js\":\"ff3080b597b585ee\",\"/knowledge-medium/src/utils/renderScope.js\":\"69f7d4e1ec22fb45\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"44240c7b32510be0\",\"/knowledge-medium/src/utils/routing.js\":\"d867776363754bc0\",\"/knowledge-medium/src/utils/safeMode.js\":\"579b79d8c168f3dd\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"c6f82fb1e81c9194\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"529fe6e16bd992cd\",\"/knowledge-medium/src/utils/selection.js\":\"388618bac9e4ac2d\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"9e466fcece8cf0cd\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"bc5249e149ded06f\",\"/knowledge-medium/src/utils/state.js\":\"de5be43bb304de56\",\"/knowledge-medium/src/utils/string.js\":\"71b5239b2f2c380a\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"faa150bd1f9e1593\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"a0b1f36fba2b2708\",\"/knowledge-medium/src/utils/toast.js\":\"8dc697de0687823c\",\"/knowledge-medium/src/utils/toggleStore.js\":\"009a20f9b3aa9111\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"7c7ab48201068893\",\"/knowledge-medium/src/utils/userActivity.js\":\"c82469d9a5b1010a\",\"/knowledge-medium/src/utils/viewTransition.js\":\"6c8d551e486a3c8a\",\"/knowledge-medium/src/utils/viewport.js\":\"520c6b89e60b7681\",\"/knowledge-medium/src/utils/webLock.js\":\"4983e6aa01b69850\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"6f364724cd045939\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"571ac29c9a85d867\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"edf452969c91b445\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"a25e6dbb770e9f23\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"4119979f8d68d82c\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"a5bf8fe125e6bce9\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"fa4e33bf6dc4c26e\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"986e51f6cc3b8f6e\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"c27b8f98a91abb9f\",\"/knowledge-medium/src/vendor/react-dom.js\":\"54eb821f6a4cd1a9\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"12e1ba7678ce3e25\",\"/knowledge-medium/src/vendor/react.js\":\"b91b9e590b838cde\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
