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
		buildId: "35085f22e2db-bde04fe8",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"84233bf9335a9975\",\"/knowledge-medium/index.html\":\"84233bf9335a9975\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-B5NWYOV4.js\":\"aa4ca9be4c70b2bc\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"d76112f4573c70f9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DvO_9KRk.js\":\"1078e8803f3ceb3e\",\"/knowledge-medium/chunks/FacadeVFS-D6_X65Co.js\":\"5d836357a948ad49\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Dtr8lq92.js\":\"ba5fa8446967b062\",\"/knowledge-medium/chunks/MemoryVFS-DoKIfJpm.js\":\"70d1a120604f5f25\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-MfTzrCbZ.js\":\"63236204175c3440\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BsybIt-L.js\":\"a453af31f752ae89\",\"/knowledge-medium/chunks/Preview-Bf_bs0cO.js\":\"264e1c9f73e036b4\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BUcNbv9L.js\":\"26381e2a6be07d59\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-C_rAjJ57.js\":\"e2782c18dce3d2a1\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-3sVgBOGW.js\":\"990e692036e6bfde\",\"/knowledge-medium/chunks/react-BZ-V0FxJ.js\":\"255b350b80580d4f\",\"/knowledge-medium/chunks/react-BZMHAjcl.js\":\"98f5fbe7aad108e4\",\"/knowledge-medium/chunks/react-BfSbr-GM.js\":\"cd30cdbc010c4a27\",\"/knowledge-medium/chunks/react-C2Ey37dW.js\":\"03c22640813717e4\",\"/knowledge-medium/chunks/react-CBM2kZU-.js\":\"aef8b7947f1159b7\",\"/knowledge-medium/chunks/react-Dr5TbqqB.js\":\"2be0532f12978ffa\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CXMxMqbY.js\":\"81f3cd47999860d5\",\"/knowledge-medium/chunks/react-dom-server.browser.production-D169JA0x.js\":\"3802af9478d559bb\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CZDpYseo.js\":\"c5bcb2033581ee4c\",\"/knowledge-medium/chunks/react-oqMvbarv.js\":\"7cd85b6bb1bd5f4c\",\"/knowledge-medium/chunks/server.browser-B1LnNOk0.js\":\"50679d748d30a537\",\"/knowledge-medium/chunks/textarea-F7-u6E6A.js\":\"59743ca976883f49\",\"/knowledge-medium/chunks/ui-DbFVeJYI.js\":\"05c2134b93fc29d9\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"dcda4b2aa52e8c94\",\"/knowledge-medium/src/appUpdate.js\":\"d532c111b3cf5078\",\"/knowledge-medium/src/appVersion.js\":\"4e8d1fe09c6ce988\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"7c688c5f99910396\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"5f6bf9b2b607afe8\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"1f5b14d63a4f1102\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"144da3d3581be200\",\"/knowledge-medium/src/components/BlockComponent.js\":\"12b696ca51f13c01\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"9ca007eadf237813\",\"/knowledge-medium/src/components/BlockEditor.js\":\"d25978dbc86dead3\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"6c126f30b5a18a4d\",\"/knowledge-medium/src/components/BlockProperties.js\":\"206c4135b319b7a7\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"d96c974d9fd3efe7\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"30eba9376ed02863\",\"/knowledge-medium/src/components/DividerHandle.js\":\"0600bdfd9dd01ee1\",\"/knowledge-medium/src/components/DraftEditor.js\":\"5d5790687c349e5d\",\"/knowledge-medium/src/components/GutterPill.js\":\"4bdd2910fdf3d4f9\",\"/knowledge-medium/src/components/Header.js\":\"c4588973fb2ae252\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"81b9746fadc34d6e\",\"/knowledge-medium/src/components/Login.js\":\"e2b024f6afed1f4e\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"166bb4c086eddfa6\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"bd54ae59382a704d\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"5a7ed369dbeaff3f\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4fa4aaa445708b2a\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"853e9d7f33d581ee\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"232dca256716f819\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"6153dce3ce94647f\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"1eed4a0afd513e4d\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"a03dfe9ab68909ce\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"c9b9429c0bf7f87b\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"c6c34a0eb5bf079e\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"b884f673f410484c\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"53aa0098433eaf84\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"2f91d6ad15eb00b6\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"768bd4bc2155e882\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"a684d652b489b7d9\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"9b7d65294b6f4d08\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"fd165a47cdcb9197\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"21c0e107f8e0d806\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"6b89c26e3c47ec1f\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"fdf65470bf314b47\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"7f817c8fa230ec68\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c15ddba4cca7e79b\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"18c2282ee8a10cd3\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"ad3ad6ff933ac336\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"129c6f76f318c744\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"7254d1c8514a9ab0\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"dad9d79f6c371d2f\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"97dd443fe54c0e2f\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"8d5bc343537a4977\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"56b57a43a12825a1\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"3477c5194434a1b3\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"842efa5ee21ffefe\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"d11bf73555b41a23\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"aa8c82afc14d3689\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"09310afcadfbbe15\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"ea100278339995ec\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"35099b08b68454d1\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"beeedfd506e82f56\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"9c5780e27a3b2371\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"7dd1cdf84416baac\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5a970b259f0b1658\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"1e7f42d7ddb4d524\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"59be307b4ef158f3\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"941e68fb3509bb08\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"85db1cf3558ca59f\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"aea9e143ccf11849\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"3a44afd377ca5232\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"856e4cc85ab0e8d2\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c2f172010742d753\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"d555b53d465bf4fa\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"314224f8c1934a82\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"d4f077f62d7fbfb1\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"632748e9372faf08\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"d4de0bf0656c75ee\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"87e99dcfb1149b52\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"56aea3eaf4e93e89\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"cd87b7459ff80db9\",\"/knowledge-medium/src/components/ui/button.js\":\"4aac87d5b79d6f1e\",\"/knowledge-medium/src/components/ui/card.js\":\"19129622375af80f\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"ff5a437bb987df07\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"6b2141366457e548\",\"/knowledge-medium/src/components/ui/command.js\":\"9b2ecc325fb13ff5\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"863ef59b6539c925\",\"/knowledge-medium/src/components/ui/dialog.js\":\"52293e628131f015\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"d311c7ccb5725d63\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"8628108742d2546b\",\"/knowledge-medium/src/components/ui/index.js\":\"6e81c177c3d5f8be\",\"/knowledge-medium/src/components/ui/input.js\":\"4e5bc3c01c3d8548\",\"/knowledge-medium/src/components/ui/kbd.js\":\"e940b69a50766680\",\"/knowledge-medium/src/components/ui/label.js\":\"68509f80a3b8e75d\",\"/knowledge-medium/src/components/ui/textarea.js\":\"e51fdb91d87b81c8\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"a8e56929b9eac0ef\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"5662e72e27d4b4db\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"1f8f779b434c4fcf\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"6416041e7f75193b\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"36e7650b46aa3288\",\"/knowledge-medium/src/components/util/error.js\":\"4e1c790f29da188f\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"9a1c97a760daf032\",\"/knowledge-medium/src/components/util/suspense.js\":\"67f41a76f8f52b8a\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"a1188ce7f0dd0a0c\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"a3ebf516e7ec2915\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"cfdd5135be3f42c8\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"d64eae95dc16deec\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"10cbd0940e7dbc08\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"50b4249831d7f79d\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"5aecfeb6d4843cba\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"620f78cee57b5118\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"25268f3ed982ade0\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"f7eebae87e607a63\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"90e62bf5ff6f2b92\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"ad7b46f459153ee8\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6c535252302dbdbd\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"4eb04f83fb200fed\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"ac78e0024a514946\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"efad3157994fa96f\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"3bb5355246c94207\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"1c5361cf130764dc\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"9155cc8cb8a3cc5f\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"d71059890fd5bc98\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"88efece1a069ebe9\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"32c245fe000575d2\",\"/knowledge-medium/src/context/block.js\":\"3136707c1159f54c\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"2a46d13725d583a5\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"645c208879df1676\",\"/knowledge-medium/src/context/repo.js\":\"4865384672f4e729\",\"/knowledge-medium/src/data/aliasClaim.js\":\"791c9fc4a9eadd9d\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"ba60be49aa9c5d93\",\"/knowledge-medium/src/data/api/blockData.js\":\"db941bb73677472a\",\"/knowledge-medium/src/data/api/blockType.js\":\"a86d4203d60880a9\",\"/knowledge-medium/src/data/api/changeScope.js\":\"139eff89552620c1\",\"/knowledge-medium/src/data/api/codecs.js\":\"6b1d01f6c704fdba\",\"/knowledge-medium/src/data/api/derivedData.js\":\"f2d506cf8fa34702\",\"/knowledge-medium/src/data/api/errors.js\":\"2c3fa25ca07c577a\",\"/knowledge-medium/src/data/api/events.js\":\"5a4f2982fa4d6621\",\"/knowledge-medium/src/data/api/handle.js\":\"99b80bf86085812d\",\"/knowledge-medium/src/data/api/index.js\":\"d34ce000aef2c1dd\",\"/knowledge-medium/src/data/api/mutator.js\":\"dec1f00e679a1b4f\",\"/knowledge-medium/src/data/api/processor.js\":\"c9a687b443e4e6f8\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"21a6b1eb4f69dd86\",\"/knowledge-medium/src/data/api/query.js\":\"979ca820f56469b7\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"4c855533360d9aed\",\"/knowledge-medium/src/data/api/schema.js\":\"99b80bf86085812d\",\"/knowledge-medium/src/data/api/tx.js\":\"99b80bf86085812d\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"2758a7ff448a419e\",\"/knowledge-medium/src/data/api/user.js\":\"4f10fd1273799afe\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"54014672f0c18881\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"cde571811a819020\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"43092f26cf59192e\",\"/knowledge-medium/src/data/block.js\":\"2b983235ad2ce5a8\",\"/knowledge-medium/src/data/blockCache.js\":\"52dee4d997ba168a\",\"/knowledge-medium/src/data/blockId.js\":\"dd7d4ae4e7ce8c0d\",\"/knowledge-medium/src/data/blockLiveness.js\":\"1a55e1888833e1e5\",\"/knowledge-medium/src/data/blockMerge.js\":\"6d1fc9034c13f33b\",\"/knowledge-medium/src/data/blockSchema.js\":\"19f6ff24293b8e7a\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"b5fb4f8952871e7a\",\"/knowledge-medium/src/data/blockTypes.js\":\"870ed0bca82c32b7\",\"/knowledge-medium/src/data/childrenView.js\":\"978adc9660090116\",\"/knowledge-medium/src/data/clientContext.js\":\"78fa67c0e1c46c9a\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"eec81620d5d0d57e\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"fa60bec224d6f458\",\"/knowledge-medium/src/data/derivedIds.js\":\"4cc4233c1ead0405\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"2e4c0aa1bf36f813\",\"/knowledge-medium/src/data/facetBridge.js\":\"e5bcf24c7241e227\",\"/knowledge-medium/src/data/facets.js\":\"2ddd3ea92dbf31c9\",\"/knowledge-medium/src/data/globalState.js\":\"59a5a3cc7f9327f4\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"d460d69f2f0d4c94\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"add13986f84a16bd\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"0ae363d67b751ac3\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"5ba2d477e8dcb5d8\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"d4acce19b3b8a575\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"99736cab90191847\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"2a970dd5e347c9ea\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"b47895f27f9e57a1\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"c96d7a1ad1d6e440\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"833375b46a963faa\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"fb6add63aa11dad5\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"6b54cbb39e15dfc6\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"f04cfb833e755b8c\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"fde5f4e610c99335\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"6541d0492019163c\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"5af59d6222124451\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"e569a92973808765\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"f66e8508a5d8f032\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"ba9982d8ad71bbf4\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"d6a6bfbcdba551d1\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"ea9ca95bb3e9c8b6\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"f5ef0bf3d09f81ff\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"8cc8d9cc391ee9d9\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"e68519c5909ffc5f\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"04553ab87eb7081a\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"1dc9e4b28a44eb4c\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"9e5db3c5a0fff94d\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"8a85e186273f4cf5\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"556690968abeffc5\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"493e80528ad371ca\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"6e635579d950a90f\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"937a1686770aab74\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"d80b7080d2e31df5\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"767367d8c665ec8a\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"b688567f9872fc6d\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"5331c934b099e91e\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"25d119bf6d0a43df\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"0eb761c2807125aa\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"f06a84335faba268\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"b83af17082532d4b\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"1d097a4b8591d1ad\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"e2b3b336ee79e231\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"bd352cf682621e62\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ae8e5539c0d9a0f1\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"8a40b6e07d43b8c9\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"1039da2ed780d075\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"926b2680efbe9d8b\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"dd231b181c95e391\",\"/knowledge-medium/src/data/invalidation.js\":\"2ddb3e1d3dbf9763\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"1d5392d98458a08b\",\"/knowledge-medium/src/data/kernelPage.js\":\"816a0c87a590bbfd\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"88486281a0cf0f1b\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"b3db4ad97f882a3c\",\"/knowledge-medium/src/data/localDbStorage.js\":\"a56830ad8f3f5df4\",\"/knowledge-medium/src/data/localDbVfs.js\":\"9559d992082fa956\",\"/knowledge-medium/src/data/localSchema.js\":\"46777cf11ad878ac\",\"/knowledge-medium/src/data/maintenance.js\":\"a88c72a2bef35c29\",\"/knowledge-medium/src/data/mergeProperties.js\":\"de60d4835439f8e4\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"2a96b6d4b51c1ff7\",\"/knowledge-medium/src/data/migrationsPage.js\":\"5eb217b763c73d3a\",\"/knowledge-medium/src/data/mutators.js\":\"6f8ad7eccd248cd0\",\"/knowledge-medium/src/data/orderKey.js\":\"f2047df8f9fe4661\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"24e2708842b15426\",\"/knowledge-medium/src/data/outlineSurface.js\":\"69643558fd0ebdcb\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"f4b1582a78c8d233\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"92aaecadab40fbd7\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"268eeffb55d24c0e\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"8b1c7d250aaa83da\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"a2b5a02606663980\",\"/knowledge-medium/src/data/properties.js\":\"3d951a644b2cad54\",\"/knowledge-medium/src/data/propertiesPage.js\":\"1e70e79bfa2fb205\",\"/knowledge-medium/src/data/propertyChildren.js\":\"88923df4f4d13b63\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"a32e97a9f4532e13\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"666587865e31479c\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"63d6946819eadfdc\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"75886d1acb216f25\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"74b334c462a9bd05\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"f6a94499e8ebcccf\",\"/knowledge-medium/src/data/propertySeeds.js\":\"1ebfb8a1ac57419d\",\"/knowledge-medium/src/data/recentsPage.js\":\"3d79590b87d5a334\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"ece50e87345b939c\",\"/knowledge-medium/src/data/referenceBlock.js\":\"57e401f73ce063c7\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"97bfd11964a21175\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"3e4cdb14234842be\",\"/knowledge-medium/src/data/repo.js\":\"a29310af6384430a\",\"/knowledge-medium/src/data/repoProvider.js\":\"253e9f2e47e23632\",\"/knowledge-medium/src/data/rowProperty.js\":\"090e2d572e324d6d\",\"/knowledge-medium/src/data/searchFilter.js\":\"01467ad4734b0e59\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"a991b4d3be4e1540\",\"/knowledge-medium/src/data/stateBlocks.js\":\"9a9f277d8ebc735d\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"13a3140061d958e2\",\"/knowledge-medium/src/data/structuralInsert.js\":\"cab565609791e44b\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"ac5f040b78017a80\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"c2f640bfa5a769a4\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"3c60d7f90ff614ad\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"7acc39e655a63649\",\"/knowledge-medium/src/data/targets.js\":\"0613a527eac2a35a\",\"/knowledge-medium/src/data/typeColors.js\":\"a374ca01417bc27b\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"777ac07387909764\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"1aa3a3df58987dba\",\"/knowledge-medium/src/data/typeExtraction.js\":\"1d213b07f2d89768\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"3200a43932b7c426\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"265320bb7d4cb5ae\",\"/knowledge-medium/src/data/typeSeeds.js\":\"1b0a6d294c597ffe\",\"/knowledge-medium/src/data/typeTagger.js\":\"5143a72d19bf60b3\",\"/knowledge-medium/src/data/typedRecords.js\":\"e46034814c270fae\",\"/knowledge-medium/src/data/typesPage.js\":\"5019ff7c8632995f\",\"/knowledge-medium/src/data/userPrefs.js\":\"9b81bf636dfa3f95\",\"/knowledge-medium/src/data/userSchemasService.js\":\"73621620c576e2f8\",\"/knowledge-medium/src/data/userTypesService.js\":\"6fba3f3c9b1ed631\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"04c428553a731f5d\",\"/knowledge-medium/src/data/visibleChildren.js\":\"f20e35d5489b168b\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"fbf379670bfbbd0c\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"6849f2002360dfb2\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"b945f953e2b6d923\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"2abbb9ff7f63506f\",\"/knowledge-medium/src/data/workspaces.js\":\"65ed928e8237068c\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"a06dca9af8c360a7\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"fbd7ef35f53d49dc\",\"/knowledge-medium/src/editor/atTrigger.js\":\"db7b79c23b1427f8\",\"/knowledge-medium/src/editor/autocomplete.js\":\"6b8ca3440b0685ae\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"bc68d36ba9acc282\",\"/knowledge-medium/src/editor/contentFlush.js\":\"5085a30835efad99\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"dbc072f06adc8c5e\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"6c6e1c276bff2b1c\",\"/knowledge-medium/src/editor/insertImage.js\":\"7e6c92eaa660bc6b\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"865316b0c8c9729e\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"377eca26b4494c6f\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"61a51c0e69c57321\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"59567046268d6955\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"34323400e314953f\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"c02140a665c0836c\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"aa77cc40a5245a58\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"6cafe81228364cec\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"b8c11901d95c77ed\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"9c00b91e06ac0564\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"cacef271516a2a92\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"a05c384fdda29405\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"0b55fd03a140e5ba\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"00cb72bc6dfdb1fa\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"684cba5630872a68\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"68d0fba57990c2ac\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"da20c9caa3eaeb58\",\"/knowledge-medium/src/extensions/core.js\":\"9e5b65dd8cc7f5d2\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"6801496c6f54d70d\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"6d80af08d167f7ad\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"312e07a24dbf1923\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"b03945b27c1aa7f5\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"8339b4262b348c0c\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"0d49ad542d243c45\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"ae80c2912953270a\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"3c46261d4a97566a\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"1a11acdf28a9af29\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"3ce7ae573baa6eed\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"243bbf236b48ccde\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"6c352a1bdf3876eb\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"37165de5d4245e4e\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"6c7b2a6c0e90f827\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"5c11cbc8b20d468d\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"6aae4fe847a6ad84\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"6bc8a2c10f4733b8\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"8842dfd997595a99\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"b24cd38441fd6b94\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"1cd11f8e55c6583e\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"dcf35e209782adc1\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"d2f06e3cf1c93bac\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"73744924a91e3c56\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"b4493b87158c9dfd\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"a6d1cb707283da0e\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"cb89225e3b52026a\",\"/knowledge-medium/src/facets/facet.js\":\"1c6cd544d83f5c36\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"e2fa53a521ecf2d2\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"ec0442a165e90226\",\"/knowledge-medium/src/facets/togglable.js\":\"1b2f1340b69d0553\",\"/knowledge-medium/src/facets/variantFacet.js\":\"2f7166e04ce4d00f\",\"/knowledge-medium/src/facets/verbFacet.js\":\"4b4ec5cc53896ce5\",\"/knowledge-medium/src/hooks/block.js\":\"ddc93489f31cbda2\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"64f2da7411d5d582\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"670641807b0fb0c7\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"0a216d8195990e17\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"97b8ef5cb14ab58c\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"c7494323102be1ec\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"a879ba81f1f6c77b\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"f5038bc2bd283f24\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"6090b969240dc741\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"a2360634e8884bce\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"c20abab0443d3941\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"58045f7571253264\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"7223eb615d2f2210\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"0b05f470c89ff982\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"62718ae5311a1c9f\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"1497c440c6ab74f9\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"3518ee70a77765d9\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"04f214e9c4dc9465\",\"/knowledge-medium/src/lib/utils.js\":\"407d43157f3b26e2\",\"/knowledge-medium/src/main.js\":\"93a22a51ef3dcfe4\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"04b136dbdd22e42b\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"64409b8a8caea181\",\"/knowledge-medium/src/markdown/context.js\":\"1c0eb8079ef963f5\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"45dce0f8d0a68f2c\",\"/knowledge-medium/src/markdown/extensions.js\":\"6a7f23d8ce1b3cdc\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"0e3f834f0d3e7826\",\"/knowledge-medium/src/minimal-editor.js\":\"f617fffb8fa80cc6\",\"/knowledge-medium/src/paste/armedCut.js\":\"2929effe84955daf\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"0d1c076302e917c1\",\"/knowledge-medium/src/paste/clipboard.js\":\"18d008625fca26c5\",\"/knowledge-medium/src/paste/decision.js\":\"4ce9b9010e485709\",\"/knowledge-medium/src/paste/operations.js\":\"c9fa0aee49e9575b\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"cd199ddbbb936a5c\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"058000db83b2f14e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4101f43690955fe8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"f472007bc1c973be\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"e11748aeaa868146\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"64bf39cd47b7904e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"3a023b7e27526b1d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"e3a84f61f8a44995\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"20945ba87c83dd62\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1269755e93b0deb5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"331785a375f5ae34\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"39991c255c9bc5af\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b0f09f533d45ecd0\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"15837be98c34105a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"95d37d54da9b6889\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"aaa688152b19d967\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"be2b9fc5c1e95fea\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7bfad2d4483ef1d9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"c3c19b2896e45278\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"73595997f3ed0e56\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"5a30fd7ab10cc3ee\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"43d5a46499ffca19\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"aea8a29d3cfe0787\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"5456730800fece98\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"7443bd47feec3c12\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"7a601b14872fbcc4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"3f26d05573e52964\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"099564a8066e4996\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"c9d0fffd7bc4ebf1\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"e3587c08b7a08369\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"efd29d55c3974215\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"47d1008c5699d88d\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"1c2dd39130fedd3a\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"455aaca587f3500d\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"0aa57fc79c78cfaf\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"f87982bf29a7d99f\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"41d4bc46709550a3\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"799afabc18b03e52\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"9c718f0d7e8cf20a\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"37b153c4bd35b9a2\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"a4b50d166e87b440\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"f5e5fca68685f4f7\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"80b3acb962defa80\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"a5ca8b7acb101677\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c3eaa3ed38ce407f\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"9f4652d88a1a37fe\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"6abe83e84c53a9ff\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"901f89d308522d6f\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"eda8163cba5ee0d1\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"ecdfab35fd5dab8f\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"22ce22de81c8cf72\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"e9cded8b8d8a364d\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"7ad1a058b5429ea1\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"5c58710ced99f1b2\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"8da4233473fd9b3e\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"f405bb6f6fa88ffe\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"645d1d81b943f125\",\"/knowledge-medium/src/plugins/alias/index.js\":\"044db4779efe140a\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"ed0ab437a95df36a\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"5e2f29e481ece94b\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"7e87bd31c8432fcf\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"a912a0138fb46dfd\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"e08a70197a837718\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"393feb4ca9690afd\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"763f2449c777012f\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"f5d3f59c67a1c262\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"fa0083bf35cc7ff0\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"6e8fd6681588926d\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"9cd110977b2e03bd\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"943e3a5dc06665bd\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"c8b603d15ffb26f9\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"9071ed75cc0d5808\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"15709a5359464ad4\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"004424522b6b1468\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"31fc1047578c9742\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"29b9073d7da637f2\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"3a5fa4f28d6e6461\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"74a0a9582e720ee2\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"b9e4eef7843f2401\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"5dfd067146c4cd57\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"00eea73e52f9b3ca\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"3f61a81e6a9e1e9d\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"bda3ed7118fcfb09\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"c3b7a5cecd02d14a\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"cd848a8442101c84\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"2792fc5c7560c66d\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"209b3fa596813db5\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"3a3087278da78f2d\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"9f4376d130644536\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"ef1397ecfc846d48\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"92e2d2438443132a\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"067c7220cb2ef187\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"46ac49333a7fdd24\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"7a79eedc723ed135\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"ce22c9c719d5f3a3\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"8b128a069a5281cb\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"b3bde09f44bed240\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"4e6783fac498a5e3\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"51ed8e30c72c2e36\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"9185047e7e244732\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"d984f6958fa833d9\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"d3325064e5e860e9\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"836361ac379a2611\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"ddcda751f16d902d\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"9fe302a63c22b711\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"6839e00e25e1297e\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f03fbab3e82d1d48\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"100d312890d286f2\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d1242c2aa391b4f8\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"5e115156d66c8d48\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"135accd7f8827962\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"3c6b98a6f1248a59\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"46938cb80811e5ee\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"d53886188b45bdc7\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b64aeef65729fa2b\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"123d20e09d3c0e75\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"b910788c464e9f52\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"89ca512181a5bffb\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"7e2603e51841077f\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"ab44587831e1beb1\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"bf5113e781185311\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"0a0472f4bf0fbb39\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"f4b85a1c76535209\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"03a7f4bd51754b03\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"34aaedec1ae8db00\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"8706d340bd635ef8\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"bfefe34e7525041f\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"bd52e2fb8871aec7\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"90634c2b287fc47d\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"75a859c7df31af36\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"9b748aabab903181\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"88db93c67adf1f26\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"e130ea40a3a47d7f\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"8e4b292d8fd7e301\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"d5b31721397911c9\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"860dce5235102c1c\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"9ba408c5f26aea0e\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"73e20acb847de9c6\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"205e09c138716af0\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"e25b1494da80c63a\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"e04d526c2a87cdc3\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d538bd62708ec1e6\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"85e9d9027fb7be54\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"22366d0fb839f0b5\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"82643dbd18839c66\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"3638ee5bd89fd69c\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"f7fe0b1dda875318\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a034c2eb25b0345d\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"53d32397852a1c69\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"944230db976172cb\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5bac35bcde57921c\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"07820b0e1a992efb\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"98b3217080e40085\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"a5c8be1fc44ac7e7\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"44e53e09e5bd4455\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"8f061e865f139b60\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0d6f1224ee6890a6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"a16568900b830103\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"d4086eaf99a152af\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b490824574c952ad\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"a0bfca763d943432\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b4b1e911c14229b7\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"7ead7c149411f6c2\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"0bcca5910c73fddc\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1b634e5e3c737ec8\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"188feb1dd77b65ee\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"22c5f9106a14727c\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"01db2ff86532e0a3\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"c7b8ad6b1ea3522e\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"99f51fdaf9ababfc\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e232cd1d0ff2e0b7\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"38948aa0e058415e\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"ffcd2b17747e3975\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"9f8f3c1ad853bd49\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"fc6df1ddf2b7bdfb\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"b8d632f55fbef1f2\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"9255e1c1d0f09688\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"3c7a177cc04b31dd\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"e5c192c113387c24\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"94f36ca312b8bb10\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"46529d1d96809720\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"24e42ec9924af4be\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"89703dd35e14ce61\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"242286dd526bd23a\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"964726b0ad8625b6\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"9c386085bb14faf3\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"b63bd68cbc4885d8\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"93c770e234e427fa\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"01fb8cd8d98eca32\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"800a0d9e7c6fe40c\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"d54f4ca38072673c\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"af7a0283bdd831c2\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"2c9d90a53fd31ef1\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"235b3791f61eb6bb\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5822f5331bfe789d\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"483a45e376d35246\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"3e0830f755555d08\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"08175df0f0218a47\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"75d7dd91037dd6e6\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"becdd6d7a06c833a\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"80677f819cd3bee1\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"41557d13efedb128\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"f1f1e78495953259\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"bbb1e2a8b1659394\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"4518b690926160a6\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"40e8a62fe57d0868\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"b81a6dc669cee8a0\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"b7a98c7f8c58f060\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"fa4342b152902bab\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"9d46838352b0ec1a\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"ef5c230c39d3ee30\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"92921d78d1df0d99\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"b2b0ea94f201909f\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"e983156a46a27fae\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"564b869cf94c7932\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"e66489408d89cf77\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"586cef0f3ea233f3\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"cbb5674eb4140769\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"08c93fcb2af6e7d6\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"052a89f8480ec811\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"4738813352e12c9c\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"d5800198e4c7ae45\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"b7795fb159d86daf\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"7dd51cb1b9882712\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"82c9abd48424c736\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"997ef46637e75629\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"bf36b7e14ccc7f8c\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"c6901ad05cd1d59e\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"36195220784b8b67\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"b107975c5a133b1f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"fd2ed7007dbfbfc1\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"24152c8c5942ffdd\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"2dbcc53fa2c08147\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5048776ce36a8ed0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"abe9979b7a1775e8\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"d90aba8730857035\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"e27b311742ca6077\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9bfab7586db2ba0a\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"9270b95a5e549c94\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"cf6c7ca469d8d119\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"81834d46f7944fa6\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"701c68ea5577f95f\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"8913e9f9e21aa84d\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"b6c657b6a03c214f\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"71556950fe7365d0\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"3f5906443181ede9\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"79db60fa9b195313\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"d94696aefe7a6d19\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"1e054489466bf456\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"e73b88b6b1973cec\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"9c64383f85703321\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"fa8e0c4cec60d2d5\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"5ba61927aca7a7c9\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"09e060d680468d51\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"b78935490c132af4\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"f41ca032f5d3bbfc\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"5401269581bd6cd6\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"41fbc652656d865a\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"aaa2e823fd477cbc\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"a0d580a7d700b006\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"0423fb4fd2916c1d\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"5ab6ed62001e8748\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"c7fc64bda70d43b7\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"8389356b4530cab8\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"99b70f9012b6ba97\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"d681c699c47c2977\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"faaaba907744b843\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"34a0eee25d6a3dfb\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a2f18897fd1762c9\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"aa0bbb812c8ab0d4\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"3518098ffa89ec87\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"1d6caa1443aa2e4c\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"1427551178e6fb57\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"6132b39f307eb7ba\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"4b1e97a02b0556a8\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"093de4b913afeb0d\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"0faa6aa6dd11d290\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"eff19b3c0094b13f\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"42c1067e4bf88fd7\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"3b8562482c0712df\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"97437a481e8898e8\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"0adb5a96ca371d04\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"289ed2527d01b758\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e505cb42824f0712\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"371be24608d76dc1\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"d7ea8c6a99b2266d\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"4b8ff6a4a0759940\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"8e13176c563549d1\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"185e09b59e657fad\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"99318b18b3b920ee\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"b72ec7eb610f8204\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"294fa3f376e4c951\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"ca4e06424bd87135\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"3ccc7a7499b7682e\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"c6f3ef7bd8a365c7\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"8b483592f398dc60\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"ae9de65b40bff587\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"a8558eba8860bf4a\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"df7e0e241f9219f8\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"30ef873b0fc1e3bc\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"b008fb9dd9f43378\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"6710db5c03639495\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"921f629fe3452f0b\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"51f8264613bfa30c\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"eb420e0a0b3b0ef6\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"fe54606a35d315a6\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"7c27bb491d884441\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"7cef9f557b53298f\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"9e408ed09f11aef4\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"dba6a50abff43ead\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"2e4707313f771b35\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"168f6913f64d471c\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"6b5933e9f820f227\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"a5d2620a6433d123\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"a3698c2815bf411e\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"5c729b0ad91e7e6d\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"9369ccc6034fe2c8\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"8562c9b09318409a\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"19996e5f9e90f279\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"2b2c02167929b023\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"6e92f93f9137a370\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"13470614c786d23b\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"44320ffd651880ef\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"6e1779388634de85\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"0a304d25e5bf2c96\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"b6770f84eb4bb720\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"c0cc98550acb1e2a\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"116f46d2f032bba3\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"73f64ef6a39fca48\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"ac0764434dca8f34\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"f8676bed4d48964e\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"2537e17ffc861cec\",\"/knowledge-medium/src/plugins/geo/index.js\":\"80b0a7b4ddd11ea8\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"8458b5308f96aff3\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"95e4801a9166d289\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"398a36841f1eab26\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"4dafacf0a53b9884\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"c660180cbf659ab6\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"a8eb41d27c6486c0\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"f228a23d15953991\",\"/knowledge-medium/src/plugins/geo/query.js\":\"d8bb945f2a078fc9\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"bbf68ffae0349651\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4c12e1a6549d4a75\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"840ba6a21426dde3\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c852caeb1b38a84e\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"84ce9a9a274a2ff4\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"79072fc0586c7b4f\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"f3dcfbd307a28d67\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"15e923532f69ce50\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"1e8496c6240b46be\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"38f33f437b74048e\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"bb362437b4fe311f\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"09b158806526125e\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a5d8e51f6e920c94\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"071f281e61a10a3c\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"3d06a284229a3ee7\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"13b876e9cf43a5ae\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"60b6e08757a0cf23\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"e35a50d7c0e5bb3b\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"d9bd06ce094c4ef7\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"b192bfcf7a110221\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"3293a994d542be03\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"5b2fbcb886f69374\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"3ce7c0b6281e3745\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"8eacf5b491732a9b\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"0ea5434d1abdf5be\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"fd159fbf506d93d3\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"7c01f77ab8c85e5c\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"88cba75a4151c03d\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"2e480b4699c4159f\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"7e01049aabd4dd94\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"ce522cfa721a9bcf\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"bfa5e0e547cda39d\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"98a15922d1d0011a\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d4476e2caf157da1\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8421c938e1ea79b8\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"ea1832cb18f27526\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"667b56df8f67fc45\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"9857050a2038e77c\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"c83e71d31859efda\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"b25ca04ff0255074\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"4ecfbf045d2df30b\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"86242efd2e3ea476\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5a4e3a366e96fd3d\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"231e51e0ca70800f\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"8e36b04502ca09a9\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"e58fafec90fee89c\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"a249e08815120e38\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"e9f51afa4ff2dbaf\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"8f158ef62bb2bac9\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"330c2abef4a9a84e\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"4c2535517d772d64\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"6bb1649c15ad0984\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"89b389a91954d95e\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"991a872b959ac3a9\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"379f7c0fa7f74896\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"eca21a32bf85e7cf\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a2c9ce0ee4c031e0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"8e4e4a19461beeaf\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"3656d0042ca9dab9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e5d0eddf000a8c4f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"85d8c5773c7415cf\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"bb8cd8d77e0dddb3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"33ff37469713cca0\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"bbeba5ae09a751ba\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4f089fe422d735b4\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6a3197fe6caa4578\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"3596e922252edff8\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"6f58c7dfd10914ad\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"cc31598a5a5e38bb\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"351107fab668178d\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"7dcc287eda7fc82a\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"6c25a190d005cef7\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"e691d079633dba0a\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"af12cd34286de777\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"76e649fb76ff69d3\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"ffc8c23fa71742b2\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"0199a255fa75c7fc\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"31f15c9e449e8c1f\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"3e304caf9024be02\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"eddc867767d56ceb\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"253c7ee23a562fda\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"c7cbc278423cb91e\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"0fa653efc8dc3c21\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"976c6a7ba8bce2bb\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"9d02f32f79069a44\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"0bf483406003dbb6\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"efb740db9ed60252\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"df00803c5a6c2a4e\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"f20cfb9ea983382d\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"d7793674b6712ce0\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"e692d19e75f6a9eb\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"e0b25fb194bf531c\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"f215a9096dd27820\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"5107fc8dcf4a0fe8\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3356198aeeae8e96\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"3225896d5c44767f\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"dd6917e08c4d1fd5\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"0ed1e38f9c5d3272\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"aa6fed2261d84865\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"87b1f7d47973505e\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"5d9e2da93b88c571\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"9cd2593112917b69\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"4a58c8afbd1e30f3\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"d89f102dc5d707c8\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"f0c2572932c13b9b\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"92664b8e033186d8\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"5e205caed97d05ef\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"7ab08663f060eb66\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"00072983310387a3\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"7342c8ea3a8eef29\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"72fab3a4fb30305c\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"795da93af349ff71\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"fd4814d242b275bf\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"0a1f3b4aee9ec719\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"bcc372d219a90490\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"2e5370b9a5a1e6b7\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"36220d03480473c8\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"ff310b4daa21a23a\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"d6fa7302e610fce4\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"a60ec35c27af82ee\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1c533097775bcd86\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"ea9cb48f88dce946\",\"/knowledge-medium/src/plugins/recents/index.js\":\"956843366f181874\",\"/knowledge-medium/src/plugins/recents/target.js\":\"8c11a4e582fce88d\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"92d3095785e09522\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"d6393397b71dd2e0\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"043307c960847c3b\",\"/knowledge-medium/src/plugins/references/index.js\":\"c2c6c1ac1e01edaf\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"378834033c037e4f\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"8e164ffdd2cb64a6\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"065edfcd55cff1f1\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"bb790494e63e56b2\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0026d2cd0f27f43c\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"6c364c599ab11208\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"a8946d45e32c414c\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"3eadb810be364dc1\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d63eb2b16df75065\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"e6e11ea6f0361fa6\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"13546d3a02e72665\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3f7aad05b7e11f76\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"cc8528d7b0f1378d\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"cd533ecee82f7507\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"fb6824459ff008be\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"62772e18be12c169\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"e3debd0b0247f25b\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"e3dc920e33aeba81\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"d47e84a19fec2d65\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"12fcb71aa67f045a\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"3c2fd7618c912194\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8ea5f5bd51b52ee1\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"547cf8825c76cade\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"a15ab9c2591d4662\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"86e43af0505b642a\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"96dc2d5dcd5ef3f8\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"2fa290cfe3d3a808\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"8364108b6246ffe3\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"16f5c56cd739bec4\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"b5274ce84ab48ba8\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"c45aa75ee754a8a0\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"d6631b233512d7ee\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"03fc9ba4573dfccb\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"efb16d17215809e4\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"3b93ae7a123bf312\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"813fef124b75ed06\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"a620c1797fe6f34e\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"40d3feea3eea2130\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"56397110d3f2e0a2\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"18797e961f516350\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"863f13f0d1d153c9\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"cd2a8437a37eacaa\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"deb75c9f7104fe33\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"448f04ea9bc400ed\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"6f055f5807045579\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"893df2d6dc35ba44\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0ac63be7b61d829d\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"2837c2e60536484d\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"3c987f27bcad4604\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"08b1da918a4933d4\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"5110d2aae48e37ee\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d2c2744896e0e8b3\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"24c446fb86f3e98b\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"23ed84753aec0d32\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bcf247cb726b9733\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"45d1da1fe9f1bcf5\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"f723ab6b5d6bb6be\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"04dd7e1338d5fa92\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"15a789e0de9873fa\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d2b36ef944973271\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"92b3dc3ab6500cf2\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"f5c99de2a426c2b4\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"a03b076a9c04666e\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"48efae88baa0a584\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c9dabb2f65e9d237\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"3a8d3d9fb7549712\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"28290025f80398c8\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4efb523319bc66f5\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"1535c7decab89d6c\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a9919d5c13fa1ed4\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1b5f408bae870783\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"941ce2bea59d7210\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"103191d7a1ab5fd9\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"fc9c80765c99b4c6\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"06eac2f921725d64\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"b6fd3eaa49a24afd\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"5e236f30c0b9fa22\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"d6bbc29e01a4c4a5\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"3842ab6daa129a72\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"14f32900426df7d5\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"3d7ab64a82cba54e\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"87ec56bec797dc31\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"fec7ceec49001c21\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"2c773cee5cd3d770\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"cf91513719c604f3\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"a95634757c9b89f6\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"5a5eed780ffb2142\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"19458bc5ca58396d\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"574e2c658500ca26\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"670bdc9adc747d1c\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"41803e838906c1a7\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"2d4fbe5681c3d783\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"7e12e1596e9c1b35\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"a6dcc6466ef2c7d3\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"64cab351d0df3fc3\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"76a9aeaa4dc0d038\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"50d1acb6f2d2a5bb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"783b1532226c158a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"89a5516808453bc2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"1a31974197234947\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"5d0720eff14c130d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"73eb916a353c0465\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"fcf955101aeab0e7\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"d50f751312f67d38\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"b8ca535834bc3991\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"443b1645522cc017\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"ae517389f50983ac\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7f3ed962a18b0e48\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"895cb647637a1b35\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"299eec41e1b78b53\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"673aa8e2fef35d8c\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"e4ed2864a15323cb\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"aa71c1d15aeeec0d\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"b0830e94827f0ea1\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"62a0f7513d805e31\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"61e261c97313e0ff\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"2286094682f3a5aa\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"b122cf02f25c739c\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"37967ddbd183c841\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"5e2f99c471794b5a\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"247510ef3580b30b\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"71191fc3a5167628\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"24082a0641a52cb2\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"0f864f8fe1dc0ed8\",\"/knowledge-medium/src/plugins/tables/index.js\":\"d661933610bf7c5a\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"69fdefb72f986a1d\",\"/knowledge-medium/src/plugins/tables/model.js\":\"2557d79c45fde5bf\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"6ab8e2b17722e15f\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"814e1bf4252e2279\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"6a3baea0c1f619a1\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"31b7028918e00152\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"ffc5b3703fd4c684\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"0f0c550ae7a7b967\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"48545875a950eba9\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"4fdcff4ac36ef0e0\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"8877213399b9c609\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"2232bc489772c621\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"f5ebf33d80321439\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"53aed2717a29f3bf\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"f55a0f907f21f7e7\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"6e12022a4d417fb4\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"27ba8da6749e0b7a\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"04c2aa75bcd4e866\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"74b1896766697fe1\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"c8823868b3230412\",\"/knowledge-medium/src/plugins/todo/index.js\":\"79084178d943978c\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"1beaeeb7fa4b2623\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9e0bfac344278f92\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"a35229f3dbb4792a\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"84f53a0a886571d8\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"58f298b3f2bc65ab\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"343cdf326f1d83f7\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"0825f27f23f4ea40\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"3a5f061d2764fe9a\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"16eb10d89540f3bc\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"576ccfe34f2b52b1\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"5e00257d247e9663\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"b3f3c50a720fe1a9\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"9943ad9b55c0cf67\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"c794ee5d9e902d12\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"c9ce2134e03d847c\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"dd6377c9c7645aa8\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"1446db4f9e957346\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"477be1dd2cbdc312\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"115d9264dabbcbe4\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"9fbd7dc9621a0629\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"74c4f45f56890e5a\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"8f5f77f5b83464f4\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"95509d672351deac\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"5a2484f3ac7097ec\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"9e4b749f676bdbfe\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"821e0054272168b9\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"f15812f255bf4b10\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"8d9b1eadec49f815\",\"/knowledge-medium/src/registerServiceWorker.js\":\"445ccc0236057179\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"9ce03db94bdb2d56\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"b9507aa01455a2e8\",\"/knowledge-medium/src/services/authStorage.js\":\"ec85ea9266e01da9\",\"/knowledge-medium/src/services/powersync.js\":\"caff2269d92dccba\",\"/knowledge-medium/src/services/supabase.js\":\"d4895576a3df05dd\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"8d996b18b4b7ea15\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"4d2fba9106618028\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"8e8232c28c6b8724\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"a881a0994e916fde\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"4adeb36a2f5369a7\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"2eb76351eba80e1c\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"68d1389c21fa3601\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"f02cca9be67e7661\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"342b407f6ee5711c\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"3c37b6e8a74f1fc9\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"19f41e2764cc2fe2\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"64c4b6dbecb7e6d7\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"aff1a0713dcdb117\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"1ef5ec55f64b0716\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"2ecc8af06152bed1\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"197b30297e370c45\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"4d8c559d309c88c0\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"0872a534d03c8558\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"0787ad2c7b954004\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"41fb92f5a351f258\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"a1ec9dd212a68356\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"4278bf5ead69aacb\",\"/knowledge-medium/src/shortcuts/types.js\":\"700ebee684b06d77\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"743eef8f761bcaa4\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"983fa672f11df430\",\"/knowledge-medium/src/shortcuts/utils.js\":\"81d31ee86477ff97\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"71560f34ab101c13\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"17e1bfe81d30e53f\",\"/knowledge-medium/src/sync/byteTransform.js\":\"0284e782c3f48016\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"0c68b2f64b0c7adf\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"96e1ad726a9a6901\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"822b0a439e8ae5d7\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"c0ffad0332a22cdc\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"180b1ead77f19bf7\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"f36b5877227c296a\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"8a1875522ebec905\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"3217b874a123844b\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"9752162b7cd8619c\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"72373ad55934562f\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"643841879123f0c5\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"3f305b50e48b16ba\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"2f77f412af33a5b2\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"aa5b8d67a463c88c\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"668063d62030ac90\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"7310ef24cc5f6efa\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"7c366166df33bd89\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"98fb27723a601279\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"5feaaa3d32171ea6\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"391f5cd52de1fe84\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"534a35739a737dbf\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"96a9489ccdd3db53\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"87be02dba0aa36ab\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"56544872c1a7de2a\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"755ddaa541a31fa8\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"3ac4f6c8d89e3f70\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"c800c83e1ac6d4a1\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"0462ef4d5526ce29\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"00a8fdd6d308afdc\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"2ef54d0ee591f073\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"4f84adafb49dad56\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"ada5a06ee495127a\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"287cda8fea536bae\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"db56e40cdb92c280\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"ccb5c04e9c0de855\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"776403c503dadc2d\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e1a33c1faa3b9f7f\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"f6058c695956a42c\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"677607f7a2d16ca7\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"144ddd0642e41516\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"1ba957c51dcdc7ea\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"5d7248a6d082dad4\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"169071d8c1540e28\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"700e51380d70c0bf\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"1c8178bdedf87f54\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"4bc1888eaa212459\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"08c23e3b35c8451a\",\"/knowledge-medium/src/sync/transform.js\":\"3b2113821a2c02e2\",\"/knowledge-medium/src/themeBootDefaults.js\":\"231e72143a200bd9\",\"/knowledge-medium/src/types.js\":\"7aacb2be7fa0fe87\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"cf21f63a32efd0b7\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"5a128d7a45847458\",\"/knowledge-medium/src/utils/array.js\":\"81ca4f46e71433b9\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"8a7b6f2c227dcfda\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"dbfa646425642de6\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"82f9013e96de7fdb\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"4ddb98f758fd6b86\",\"/knowledge-medium/src/utils/callbackSet.js\":\"eb913c83ae39a2f1\",\"/knowledge-medium/src/utils/clientId.js\":\"bf762cd343ab13b2\",\"/knowledge-medium/src/utils/codemirror.js\":\"62504a051f85328d\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"93e91717c1532ea6\",\"/knowledge-medium/src/utils/copy.js\":\"18f72d0c447c68f4\",\"/knowledge-medium/src/utils/dailyPage.js\":\"42ca400bb3f58dac\",\"/knowledge-medium/src/utils/dbForensics.js\":\"4c02495db01b9d2e\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"d1adcb1a3ece5b9f\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"1b4617e726f73436\",\"/knowledge-medium/src/utils/dialogs.js\":\"3fffb82fdcb7a3e5\",\"/knowledge-medium/src/utils/dom.js\":\"97a5ce828466e51a\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"873e3b37581bc485\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"046dc086a1246f34\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"fc9583d141d624ac\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"92cfbe8a4e8319d7\",\"/knowledge-medium/src/utils/flipSlide.js\":\"a71fcd8ebe37502c\",\"/knowledge-medium/src/utils/fnv1a.js\":\"ee1dda7416c517be\",\"/knowledge-medium/src/utils/formatBytes.js\":\"f9189d55709a1077\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"b8c79a22e47ef940\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"1614ba9a56d4c3b5\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"7acc7aad76e537d4\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"376bc1ba2fc55fcc\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"27a7217be4fead91\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"dc031e56614e05a1\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"92fd8bef755da6d6\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"4434774c4c8e1ac8\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"aa9208036ebff36b\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"f423b4105eb77630\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"e426cc6815c2dd28\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"db82f860cbc120c4\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"c6d411cb4ea7b8b1\",\"/knowledge-medium/src/utils/markdownParser.js\":\"5910294466fffaeb\",\"/knowledge-medium/src/utils/memoize.js\":\"8016e77de6b7475c\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"f247087bf9465983\",\"/knowledge-medium/src/utils/nameList.js\":\"cdd76b6b03c93c73\",\"/knowledge-medium/src/utils/navigation.js\":\"617bff7093fcfec0\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"1c0837305119ebb5\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"ff845f634770bd06\",\"/knowledge-medium/src/utils/panelClearance.js\":\"7e559d4b3751f2a4\",\"/knowledge-medium/src/utils/panelHistory.js\":\"fe2dcf250db2a6ed\",\"/knowledge-medium/src/utils/panelLanes.js\":\"ad7595f91c8c8f35\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"a3e45b00c54df67a\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"b5c94b13575d8e64\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"d3c76b12fbbfb721\",\"/knowledge-medium/src/utils/platform.js\":\"466a4cacdd412002\",\"/knowledge-medium/src/utils/pluralize.js\":\"c7faca9e7e2b1fcf\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"9d2c79f57c8c71c8\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"0a3eb851f9d35b04\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"d414d43fa0291e12\",\"/knowledge-medium/src/utils/react.js\":\"c382f3d0f5981173\",\"/knowledge-medium/src/utils/relativeDate.js\":\"64f19a0b24aa27db\",\"/knowledge-medium/src/utils/relativeTime.js\":\"d733f07be9557e3a\",\"/knowledge-medium/src/utils/renderScope.js\":\"2427b0972bf1d1ab\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"82bdaa18ae94dee9\",\"/knowledge-medium/src/utils/routing.js\":\"821bb8123dc15834\",\"/knowledge-medium/src/utils/safeMode.js\":\"e32812b96496213e\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"b2b0f504ac93f489\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"1281871fce54ae11\",\"/knowledge-medium/src/utils/selection.js\":\"f9d55e5c9a0de214\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"2c4218153572a52e\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"ec8258168c7a8320\",\"/knowledge-medium/src/utils/state.js\":\"be4911df9ba1bfff\",\"/knowledge-medium/src/utils/string.js\":\"01c3bd884ced6ec5\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"d40359ea7c408aa8\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"ce7718d3c17090f8\",\"/knowledge-medium/src/utils/toast.js\":\"77a574739aa18725\",\"/knowledge-medium/src/utils/toggleStore.js\":\"0553a5c6962a3f96\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"167176a53275f84d\",\"/knowledge-medium/src/utils/userActivity.js\":\"c087c759501c7086\",\"/knowledge-medium/src/utils/viewTransition.js\":\"498d97d4b917a214\",\"/knowledge-medium/src/utils/viewport.js\":\"7f59fc8d876ea7fe\",\"/knowledge-medium/src/utils/webLock.js\":\"bc942fbc811d8a01\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"f19b7ab3261b2c09\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"0df29cf9c2b21eba\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"e3fa2cd15c6c0a8d\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"6360a8d9aaced8cf\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"bc7e824873bb71e9\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"46ebe36ace7e4a21\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"e03a728aa5e1256a\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"8ac9851871f49fb7\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"eb6a4eeb4d668582\",\"/knowledge-medium/src/vendor/react-dom.js\":\"144dd574fb0690c9\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"1fd5387dc8d18e33\",\"/knowledge-medium/src/vendor/react.js\":\"a8008cdebfc76e76\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
