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
		buildId: "3f90b8e7da7a-c8730ce3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"286543e003b13ef6\",\"/knowledge-medium/index.html\":\"286543e003b13ef6\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BAJEyHhJ.js\":\"9ab7d3d379ab474e\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"c701ec171a0f2e3e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BnKN1KU6.js\":\"c57a2e361bb957e4\",\"/knowledge-medium/chunks/FacadeVFS-CfmR15Ah.js\":\"f76206736ff0bf59\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BV7WOoDS.js\":\"17b5e8a5d40d56d0\",\"/knowledge-medium/chunks/MemoryVFS-DpYD59KC.js\":\"be1c4fb16902cd54\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DKixQbb8.js\":\"054e2d2144164c2a\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DKcnTjGR.js\":\"15316334b5084b8a\",\"/knowledge-medium/chunks/Preview-VPM__Etu.js\":\"e21acb7e11e7a5bb\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CvgxD5PB.js\":\"0cba7dbb177826f4\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BMWNfL5A.js\":\"327b847e08cbe06f\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B0ewUZFx.js\":\"e47e19b9f5fe567c\",\"/knowledge-medium/chunks/react-B40oci7x.js\":\"de6fdf93714deb1a\",\"/knowledge-medium/chunks/react-C_mV0gra.js\":\"80778f164201d2ae\",\"/knowledge-medium/chunks/react-Cusp0Pj1.js\":\"d3e90139a9c711f4\",\"/knowledge-medium/chunks/react-D2SwUx9s.js\":\"c14ac710108a3355\",\"/knowledge-medium/chunks/react-DCaLTsI6.js\":\"10cba2f11b9475e7\",\"/knowledge-medium/chunks/react-DjJ5f7K1.js\":\"bab93fc62022b12c\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DNjqyPRx.js\":\"036cb56e574fdb76\",\"/knowledge-medium/chunks/react-dom-server.browser.production-L212pIZg.js\":\"67d235b2323e44a2\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CrJ796iQ.js\":\"c901de4a6c5e3195\",\"/knowledge-medium/chunks/react-xt2Dvp2V.js\":\"3c8ce1eda48cbc89\",\"/knowledge-medium/chunks/server.browser-i79bGLDm.js\":\"b0bb4bf48db2876b\",\"/knowledge-medium/chunks/textarea-DSoAulpe.js\":\"ca83b7bb8377bf7a\",\"/knowledge-medium/chunks/ui-_PWr4yAf.js\":\"85f955dc4f0de26a\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"ee981b396d5b4b06\",\"/knowledge-medium/src/appUpdate.js\":\"d2b1c6c77749f401\",\"/knowledge-medium/src/appVersion.js\":\"5438b613a059bcd3\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"4d69effaa9f29de2\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"74653a59be6c559d\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"71d89856e001b06e\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"4a62b93fa03030b0\",\"/knowledge-medium/src/components/BlockComponent.js\":\"109fda91cf81bb9c\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"b85ebcf92feae184\",\"/knowledge-medium/src/components/BlockEditor.js\":\"adfdc7fbc0993d29\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"4fa65be68c888497\",\"/knowledge-medium/src/components/BlockProperties.js\":\"811e583611456f78\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"bb82ad66a64c75d1\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"5e567bfbf768b52b\",\"/knowledge-medium/src/components/DividerHandle.js\":\"1aef719f9f1f30d2\",\"/knowledge-medium/src/components/DraftEditor.js\":\"7254736f9a32311d\",\"/knowledge-medium/src/components/GutterPill.js\":\"f0852b5314e3b232\",\"/knowledge-medium/src/components/Header.js\":\"80956a40dbe1e196\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"3df2b8e6f8f12c01\",\"/knowledge-medium/src/components/Login.js\":\"dcb6bfe0deb116d5\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"834ebb1a86e35d3c\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"c4f0a33100cded95\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"83af2d6a6e39c7cf\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8227796574d4c78f\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"00c4326728c1dd63\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"4e20f996626623de\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"56c9f21a59228d23\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"d56bbaaa828a9fb9\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"fe7b92e4b7416410\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"ed1cae3ae0e50ddc\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"63a7b3ac0b5afc27\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"37dc313de9953e01\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"2900040df3d783dd\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"557deaf8eb007488\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"bfdecab12c34e63f\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"17b4f02e862f6cb8\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"fb663eecfd21211a\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"7decbd7a7fd180a9\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"43740223dffd4bf6\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"eef7e6d6cdbb4b55\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"96f016d920db8164\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"64959a0491d861ed\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"01cf883c3e949bee\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"9eb9e08b90d7b4d2\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"da02335dea5fe9dd\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"fd540a509e74d3de\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"059390142b8edd44\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"1fbc2ec375dbe253\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"ce497b485fc79bcc\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"4ed2aa047c74b8a7\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"300073f16c726248\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"bf6d273729542a7e\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"33d8ccba1f9cc88b\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"d8e4b972f3757617\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"ea2af0d15101cf81\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"40f69efdd36086a5\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"e31d44750228e8a2\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"818400e2ce17c1b3\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"9a39a479b4b445d5\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"99866227184deaed\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"29ff92cc481d3ebf\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3cbb19440a915ee0\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"ab86b269dfac6f16\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"568d4afb3b4c7e9f\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"5e6318780b8603f8\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"7495d2a9fbea062b\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"18c2147ed131e21e\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3a11d9b2bdfc2b66\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"0a7ff8b827111a7c\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"abfa9e78ef50542e\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"ce08065c60a1fc93\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"664087d364493710\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"31f9554ad0155757\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"a88ff2f046134114\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"9aca902b8f1d94e6\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"ab05138a404f8d94\",\"/knowledge-medium/src/components/ui/button.js\":\"e6418466eb6f054d\",\"/knowledge-medium/src/components/ui/card.js\":\"ffe6e206dfbe6407\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"8e9c10f5233d4393\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"0f43c9d77827315c\",\"/knowledge-medium/src/components/ui/command.js\":\"216de9a67d169b70\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"9ea754df6b436ddf\",\"/knowledge-medium/src/components/ui/dialog.js\":\"851e46c99b34251b\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"bb21147d80665302\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"25d386b522b01526\",\"/knowledge-medium/src/components/ui/index.js\":\"de1a0d7aef2b9d73\",\"/knowledge-medium/src/components/ui/input.js\":\"5d8937a42622da69\",\"/knowledge-medium/src/components/ui/kbd.js\":\"2d6e358b990f57a0\",\"/knowledge-medium/src/components/ui/label.js\":\"a3dcab274d4081ac\",\"/knowledge-medium/src/components/ui/textarea.js\":\"1acaaba5dc6c7a6d\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"92c8fd63456e3fcc\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"31cf728cd80a9b44\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"593feae66aa3b56b\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"c727030b6aca1ed9\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"f64c64271047e5a7\",\"/knowledge-medium/src/components/util/error.js\":\"ca6b9b86824428b3\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"e8cd201da28aa8fb\",\"/knowledge-medium/src/components/util/suspense.js\":\"c67285cdd48f37e2\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"1420562c872777d5\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"960a181da02aae4e\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"9e03b97b1e1ef5bc\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"81529164e827a06d\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"f00b6f7dd3e94b60\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"09f463b2333cab8f\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"82882d05a076cec2\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"c7de2470aef982bd\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"af7aa04ae57f0c4b\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"3867ca788c9a967e\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"b89f2d08f1e114fa\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"2ad254c7b9d8e512\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d57afd8314c5e78e\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"edd9fc92ad77b764\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"7985f85b81e116ac\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"28a0310264ceb9cc\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"bc3667e6b7932efc\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"091b70b2c255264e\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"523b8116d62cea96\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"cf17009fc78df289\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"734d65e4b97b7807\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"4ad5ee1e15ce8dc5\",\"/knowledge-medium/src/context/block.js\":\"c204850db8f4c0e5\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"f61cf1706e25bd7e\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"7c761b37f22ca480\",\"/knowledge-medium/src/context/repo.js\":\"0dac33865c175ced\",\"/knowledge-medium/src/data/aliasClaim.js\":\"8a29f4a6693a9312\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"217f3173866bd781\",\"/knowledge-medium/src/data/api/blockData.js\":\"a3accab8e8e9ada9\",\"/knowledge-medium/src/data/api/blockType.js\":\"75982cc8e224baa8\",\"/knowledge-medium/src/data/api/changeScope.js\":\"d9e59d698a8edf64\",\"/knowledge-medium/src/data/api/codecs.js\":\"a99cf18408f33340\",\"/knowledge-medium/src/data/api/derivedData.js\":\"b4a5c4528e5218c0\",\"/knowledge-medium/src/data/api/errors.js\":\"158445cbac673625\",\"/knowledge-medium/src/data/api/events.js\":\"09a0c0f49b05ebde\",\"/knowledge-medium/src/data/api/handle.js\":\"0307083b24d23fc5\",\"/knowledge-medium/src/data/api/index.js\":\"2fa708a32a54fbe8\",\"/knowledge-medium/src/data/api/mutator.js\":\"33cb55b9a99ed4ed\",\"/knowledge-medium/src/data/api/processor.js\":\"321422535bf23cee\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"f9346a60afcd9fcb\",\"/knowledge-medium/src/data/api/query.js\":\"b0c47713ae149761\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"e65322df763ac523\",\"/knowledge-medium/src/data/api/schema.js\":\"0307083b24d23fc5\",\"/knowledge-medium/src/data/api/tx.js\":\"0307083b24d23fc5\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"aed153c7f938e63d\",\"/knowledge-medium/src/data/api/user.js\":\"7ab6c82e3891c330\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"cffd425328aa889a\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"baa3c84c07fc2d8e\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"01163479d536809b\",\"/knowledge-medium/src/data/block.js\":\"8a7c82d413b32d54\",\"/knowledge-medium/src/data/blockCache.js\":\"6a6973162487ee2e\",\"/knowledge-medium/src/data/blockId.js\":\"b5a60b13d32d4f11\",\"/knowledge-medium/src/data/blockLiveness.js\":\"64653ea6ffd17257\",\"/knowledge-medium/src/data/blockMerge.js\":\"9167f131bd48cda1\",\"/knowledge-medium/src/data/blockSchema.js\":\"9e20fbdf1b87139c\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"0566ba9ad9a700db\",\"/knowledge-medium/src/data/blockTypes.js\":\"db9f344bcace0f87\",\"/knowledge-medium/src/data/clientContext.js\":\"f6e6355cf3f85fe7\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"203d9b2b052d37db\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"1a08aaad33aabe15\",\"/knowledge-medium/src/data/derivedIds.js\":\"364585527311b846\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"506ba356b2e91246\",\"/knowledge-medium/src/data/facetBridge.js\":\"49ea2c56352f3997\",\"/knowledge-medium/src/data/facets.js\":\"d4c32c1bc13928eb\",\"/knowledge-medium/src/data/globalState.js\":\"da9a2e4a62bd072d\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"140a64bed395b40d\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"9cb8494368450b8c\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"87966710ad116d2e\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"2519d6a3aec00aa2\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"7f95313c9f2a5e5e\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"2e7cc021d1d5f2be\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"8a37f7feb0437946\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"5b96ac602c895265\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"9ef195b391f99af2\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"d909e42a19b6a192\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"3ddc7a031228366d\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"790d6b415bceee90\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"73ebdc7ebf036d2f\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"65fd13005a86e745\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"a735799d11b4b7d7\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"7db97482d013aede\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"71714526a1fc21cf\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"1e673cc79d2bd7d6\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"49eb07a12e0e4529\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"6ad2faef9b17c93a\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"b64c721de1676ffc\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"dd33ca76911d523f\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"51e0f25660b86d95\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"f4409c625ed19574\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"47373d7c576a3176\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"609e647923ee80ae\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"c1588a15472832d4\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"327a8c3e2fa506d3\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"bd1228706204ce9a\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"722b4e17683d5a57\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"172b9a57858df64a\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"f7a105aeb7476b53\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"b370d7f9f36f4762\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"3e28216429714f24\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"9878b1576405c076\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"4871980b0ae24961\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"49e3fae457b09455\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"27aae43a27e2bd51\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"ac9eded280363e1f\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"03037fdff7f816a2\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"8846fc0236775dc4\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"0a5359bfb7caf108\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"7ff17d7affc261ee\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"d7f4c0ce3f6fe844\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"21e88de9715a6885\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"d3284ba2efac1a67\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"85011e9a1a048397\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"4a8534853c7f4099\",\"/knowledge-medium/src/data/invalidation.js\":\"9788bfaf02c18828\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"c9a655d1bae515ac\",\"/knowledge-medium/src/data/kernelPage.js\":\"f1c2cc76fd1beecf\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"6c59a5741e617caf\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"cab735d99941b115\",\"/knowledge-medium/src/data/localDbStorage.js\":\"aa6822413034c98b\",\"/knowledge-medium/src/data/localDbVfs.js\":\"439098f5565e5030\",\"/knowledge-medium/src/data/localSchema.js\":\"8ed6d01e0a46303f\",\"/knowledge-medium/src/data/maintenance.js\":\"2f896f9656dd2094\",\"/knowledge-medium/src/data/mergeProperties.js\":\"c7551389464b2d4d\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"772b843c48f94fc5\",\"/knowledge-medium/src/data/migrationsPage.js\":\"44284973cbed5560\",\"/knowledge-medium/src/data/mutators.js\":\"813be8cc50c50e41\",\"/knowledge-medium/src/data/orderKey.js\":\"8f1bd3fde7099ce0\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"33987dd32d4a6a1f\",\"/knowledge-medium/src/data/outlineSurface.js\":\"2df403b34a90a8b1\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"8090203cba574b18\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"a0039b7ca6e16641\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"24fa58411263e213\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"4c841b8b1439e53e\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"d7a441697b02ff2e\",\"/knowledge-medium/src/data/properties.js\":\"856b8d9260117ac1\",\"/knowledge-medium/src/data/propertiesPage.js\":\"a8c23e6ac13d6bea\",\"/knowledge-medium/src/data/propertyChildren.js\":\"f159c7eb7fd753e5\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"c511749d68bd65a0\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"761ca00095fa12d5\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"9d824c6e4b47f9e2\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"cb23e60da5024364\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"f203cece7413d90e\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"244e04419248c6c5\",\"/knowledge-medium/src/data/propertySeeds.js\":\"793142ee1fcbedc3\",\"/knowledge-medium/src/data/recentsPage.js\":\"7d4368226d95062a\",\"/knowledge-medium/src/data/referenceBlock.js\":\"d0fdf8d64966788f\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"35f23c8c9e8be338\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"ef21f06200e7d977\",\"/knowledge-medium/src/data/repo.js\":\"bb209acee94ef295\",\"/knowledge-medium/src/data/repoProvider.js\":\"ae993c1821ed7377\",\"/knowledge-medium/src/data/rowProperty.js\":\"441a487e8814a23f\",\"/knowledge-medium/src/data/searchFilter.js\":\"485a131bf2a8ba90\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"9c42074ad43b6f46\",\"/knowledge-medium/src/data/stateBlocks.js\":\"322439bf4fcf427f\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"44506459c56a6baa\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"8bbc21b54e37a4c9\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"6c27bfc765f99b08\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"ee0692fc033a8388\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"c8314463990cf5a5\",\"/knowledge-medium/src/data/targets.js\":\"0c0a4803bef34c0b\",\"/knowledge-medium/src/data/typeColors.js\":\"baebe3d627cd7c68\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"ddd199937b4d47ae\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"704bb96d975a4991\",\"/knowledge-medium/src/data/typeExtraction.js\":\"30a46f25c1fc0b8c\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"f445aecf7536c8d5\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"205b7177815564f6\",\"/knowledge-medium/src/data/typeSeeds.js\":\"30a7139879ddb4ff\",\"/knowledge-medium/src/data/typeTagger.js\":\"b25970fbd9d8961f\",\"/knowledge-medium/src/data/typedRecords.js\":\"149a46616aeb7dc2\",\"/knowledge-medium/src/data/typesPage.js\":\"dc17cd2112791702\",\"/knowledge-medium/src/data/userPrefs.js\":\"b95c28921f5f62b5\",\"/knowledge-medium/src/data/userSchemasService.js\":\"ddf3aced33b4ded5\",\"/knowledge-medium/src/data/userTypesService.js\":\"523bc3b96759f2b4\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"8ba87ec257de6f60\",\"/knowledge-medium/src/data/visibleChildren.js\":\"af4d509adb813059\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"acae02252a8d4c2e\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"85e7a486b43a33aa\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"751a858b20bedcf4\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"b178dc4aabb3c850\",\"/knowledge-medium/src/data/workspaces.js\":\"433d6f64f2f6e42e\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"0d88862304bb84a9\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"123935e50bf2022e\",\"/knowledge-medium/src/editor/atTrigger.js\":\"e512d2a73fb7b97b\",\"/knowledge-medium/src/editor/autocomplete.js\":\"f543e3bb857d742e\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"fc6e3015809b0b96\",\"/knowledge-medium/src/editor/contentFlush.js\":\"44e4e5f36aec62ac\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"f66f32799808df37\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"7b27ca3a1b33dc90\",\"/knowledge-medium/src/editor/insertImage.js\":\"93ef3b0490f9ff15\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"2e57ca5eb84d23fb\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"aed3caa0cc72cefc\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"b2fe5af16b4400e8\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"8c8c7f119c53864a\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"967a62a81ecb3b93\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"5fb231d4b0e22f06\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"386cd3de1b06514f\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"22a9f3454618c576\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"7f683003085619d2\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"c81bd2d069fc081e\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"b808a557815f407b\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"0ab41587990532f2\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"173e6faadddfa07a\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"51662334e7fcd6ce\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"d78c38adb1369354\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"abf81625e4ee0bb6\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"ec49dc95c3cf9e49\",\"/knowledge-medium/src/extensions/core.js\":\"a3deb58b6019ad58\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"f46d149d1e382f7c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"ded8f934cb13781f\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"82ed527a7a7df81a\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"19d5bc5146d4b0ac\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"201924335ea465be\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"737226e10d3ee9f9\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"f1891a8fcf7889ed\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"1d7025c5ba827961\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"d5603839910330cb\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"6b6bb8a5b8c3ef4d\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"5c34436778acb260\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"b9c3b056f8020b8e\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"95e3d5d1c011c868\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"ed444ea3c2c057ee\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"28a1e48f3a1e5101\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"e39de3cfa065507f\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"5a01543c4380f7e5\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"2cd2ebcadf176ccd\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"307b60c1302bbc27\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"cd47e6b56e3d3138\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"6ef0b4dc9698fd80\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"81569a130f20a70a\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"b55d8410601abe2c\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"90bad3bc10466db0\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"69dd4f6d27e9b7f7\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"c5b95db4d22ee149\",\"/knowledge-medium/src/facets/facet.js\":\"47090b35c45eb7c6\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"a81357105781fd4d\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"ce38cf056775f877\",\"/knowledge-medium/src/facets/togglable.js\":\"edf288ac71f2ebe9\",\"/knowledge-medium/src/facets/variantFacet.js\":\"a898cca1bba27adc\",\"/knowledge-medium/src/facets/verbFacet.js\":\"869d0217fe712fcc\",\"/knowledge-medium/src/hooks/block.js\":\"cfee0df43d840a25\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"1f432b8321b8f0b0\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"53f20b28f9fd7dd9\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"54c93f73dd4eb010\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"df679d1b02e9762c\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"08ef047b31c0f009\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"5a542c2b1ffd374a\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"217b8f15bb89f8e7\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"3f12d743b3451faf\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"bb0ab1ca1f4509ea\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"13ae5ac2e8aeb9c5\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"276f77743ad6031e\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"b4a6d8591ae49390\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"b5e26e2967058648\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"bc61cbd2209e0313\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"abd843ec99b7261e\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"60f66f901e6ad96f\",\"/knowledge-medium/src/lib/utils.js\":\"a829c84ddf7a6152\",\"/knowledge-medium/src/main.js\":\"8a05b7a84f20c3c2\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"87d0d300628a61ce\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"ba16144f38cbff84\",\"/knowledge-medium/src/markdown/context.js\":\"4448de1ef677c69b\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"fefb3f014ba30409\",\"/knowledge-medium/src/markdown/extensions.js\":\"8516bcfc88eff28d\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"bb28957bb02638e5\",\"/knowledge-medium/src/minimal-editor.js\":\"31bc285b69644ed7\",\"/knowledge-medium/src/paste/armedCut.js\":\"74d5443493491806\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"fa36bc08870efd87\",\"/knowledge-medium/src/paste/clipboard.js\":\"676fdd793a20522b\",\"/knowledge-medium/src/paste/decision.js\":\"09ab5e5bb7fd2b4c\",\"/knowledge-medium/src/paste/operations.js\":\"bdc4967c249e8a8d\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"fcbaf194db421eee\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"3e27f58495e3bcd1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7317135a671a59c4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"3c4487807c760937\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"f314527683bf6b2e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f0083b1f7bb53d1b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"47e9c840f0a9603a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"5a48cec1d9c8b07d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"73326387c50a3fb1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8a0fb3477fe5ed4e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"a88dcde7c5a1af38\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"774ffd335b7918f4\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a40646bdae3d13bb\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"350148ad01d23ea5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9295521611320c92\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"135d2bc3b6818bf7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"04e58114958b5487\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1d5650efa2714a41\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"b077cd593f6530f1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"fec725cf1ddb82c1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"022ea22f31f21ff4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"f4a38c4c640293ef\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"8b68fc28f4bc98e3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"1d8b8a62b388f8ca\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"c99912c8e1c40f03\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"23b62c19889f7445\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"f15aac0454364563\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"32442357023a1a82\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"ea2aec4ae53bf0a0\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"b1f639eacaffcc12\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"705ed006b9753b08\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"93fc2307fd60faba\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"08134820b11b5ad0\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"4ba8129b724660f2\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"4543bfd983db8419\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"df1bb2e8c71feaaf\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"10b31c91c1bce52f\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"efdc450aac1bd2e5\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"48154b3d689c340b\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"df16f6f28d6f335b\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"faac72db31316d3c\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"44c22bb858711527\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"48efab8a799d33ea\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"803f72357874eb3f\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"fe40e9cbfb600638\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"756f760d0956ea1b\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"cb1486ec650e7333\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"dd09a89f06c55773\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"32a9f2713d243746\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"fdace37785c0ed6d\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"c5e4e22a310b7121\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"82fcf32f401b265a\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"8e0fd653f4fee121\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"3ba66cf9481a93dd\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"4188245a9176853c\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"96b406687770c2c6\",\"/knowledge-medium/src/plugins/alias/index.js\":\"f223a7fe85330ae8\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"f29aec18e2557fc0\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"f6ad14f6b838dde7\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"11a9d505fa19e4df\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"854d40d80a0209ed\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"46ad61664f2faae6\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"7af8d0ba06258a8a\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"391aa73d67cce33b\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"826f496d6e51d8ae\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"cf9212a45a48ebdd\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"fa4fdfcaeae2726e\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"cf49e5985b3300a5\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"d9b228a64503abcb\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"ff377d94ac3e04b6\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"4fa80fbf550ef539\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"236123cb5156ef53\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"cfd7bf49a9d12584\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"5830a5cb8af5c8e7\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"99b2508e5d3dffb6\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"b6a1947eb54e6a8d\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"b94e20c7e6da3525\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"e372c75462f3cf53\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"49b5b6bd1c999b60\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"14455364f1e67aee\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"da245a25b9a5a75e\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"597f331dfc119c38\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"6d923ca4fff13e90\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"b995f1c4ee726290\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"be90dbdad0a8d58a\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"24169f7a7f6383de\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"3bd5f80d264edd7c\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"60a496e698ff08cf\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"d8c2db6aa87df667\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"f6da77d1353bef46\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"27a3932f27661fcc\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"1a2897a8d816d3d6\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"26a8a66e78578b7d\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"2644fcd20d468f08\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"654685ed47c12d46\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"330d6f231a0daedf\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"c4d25e0f56eacc02\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"2367dde557663111\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"2e2796efc9e168a9\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"667d28f16210a6b3\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"9009c19ed334765b\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"0123cad30d3dd4db\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"dcf62203647571b4\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"4aa2400ffd9a8f11\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6a401b5a2891c902\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"53855d96017df9ec\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a1e3ce09734bb291\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"fc8b494ea880a46f\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"e0497f9a185bcab5\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"48daf871c1af4d36\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"5697fd63df3ae1d1\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"4fb29904c7287788\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"180077cad9bf691e\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"9c546cd8eb1266f3\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"bf89c61eedfe4a74\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"f4685dfb30a00567\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"be7d0ebc620180e6\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"9fbb577a756ffe2f\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"2245bed40fa185c4\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"19fd674092309e66\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"58067856612224ab\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"db21109c779c99f7\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"2feb9c893dafee84\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"8ee5f390f34a7a6c\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"aad5f576134c0ef8\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"5d0add964c864d5b\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"7573dcbe904c82be\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"85f39b07bce68f00\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"5c4ac43d89161f00\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"c5d1578a64993009\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"90cbfaf55f4831e2\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"d2bb90ee9bd20d13\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"661c8b995037f9db\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"167d72cf7e97a3de\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"386454db1267c8c2\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"ba067152d910ab11\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"7540ee8c765ad953\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9202a797b7143dab\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b205ed0180e4d504\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"8bbd1d6def4c120e\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"17811e0992385ff2\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"77278b8392d0a748\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"ee3394d5dd2e7fed\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"fc97b8cee4ef369a\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"565dff37ad44b827\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"0eecfa7656160dce\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a56da1e2293bfced\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"ff18503666a3e27e\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"8ddd427d691f66cf\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"d95f93f41bb8e6b2\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"effdcfd9fdbc8f16\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"9d284f0d3f966307\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"83d598bb853fd23a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"cdcda96f809ca07c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"d9144f806efef185\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f8d0108e0be4f06e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"39a509f89003befc\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a1f123a4fed3632f\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"2a2d761275da7a77\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"3175b32b18b6d4b6\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"6d14c1189acff135\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"6304d231c2bda5d0\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"fb1c9cad350a9007\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"2b614e2a963d3253\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"f1b22d0b72d8df7a\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"2a4b454394de18ab\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"8f9ffbcda6253ebf\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"acbcb7a3704612bf\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"aace83aab81c10ed\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"405d84fc84e5b7b7\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"04426cd172adfbac\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"85f1aa7f71a8e65b\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"15aba655da02d301\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"6db9c310a5230ced\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"c89d030010fd9d8b\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"1ad6df1a004100e4\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"77786257e00fd147\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"81bf146f1ee290ce\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"ce5b8e3db4814823\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"e44f6e299f2e15af\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c1c17380785861ac\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"cb9ff513f1a72efd\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"89da6da86e9c4c09\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"4ec1628a2077870f\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"12e7764bb0a7e9c4\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"0d3364aa715ffe2e\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"aedfb024573f4a73\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"aa873f1bdc2bde66\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a917a7b9edd5ab27\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d72781333ddd9698\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e19c49bb2b32308b\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7f3c7ca0590d6919\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c538498aaaf7cf27\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"624e47868f0087d3\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"38fbe9a6eca67d05\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"9f092971ef5f203e\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"38a7248047aa00f3\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"0821c7e604dd10ed\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"90e9fced4aa5302a\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"0a2e777f38c63c09\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"bdfc5ff950040279\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"2602a407ce45487b\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"08e8ecbb05218121\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"02cd2c45d82daebb\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"3a8c5c54d22aed91\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"612fd315fe4fc33d\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"bfb626f1261edc8b\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"3140eb4c90d63b1e\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"86e28c1a096d3eb3\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"8134be30cd263fbb\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"f84caabcedad390e\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"28ea5edfa8bfecb7\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"818962227453f14c\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"1597b5632fb90793\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"aedea6f1cb191c08\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"7acf207c1f126e16\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"dd2b1f2a65a06054\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"0f2dfde1af548a88\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"c94ff22892f86114\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"39cfb5100e65ced2\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"de9eda2865a1eca6\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"6743a1c352793e01\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"893a232958bccbe6\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"5e98fcea7de3d081\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"fc0dd057935a0b5a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"89f75929f89c6630\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3c10c29950dd1c6d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"fc0aa5d1ec3c186f\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"16ee2543aa87e086\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"ef5cd0d687e18637\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"be6c23b2d98723ed\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"c69922f218f04fd5\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"1d8d49049e59289f\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"a1f3f7c32be650c6\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"3659adcaa85119c7\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6ad27c79c1667aec\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"c7096dec7689501c\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"2e03490a222999a7\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"ce2c45ed93335c4f\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"7ed5631deda63f68\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"f1cca41c79cbd2c7\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"1e9fc1773f20bfb3\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"ec65d117c38b4a9c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fea79e3b797b23af\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ce80cba56f022cb0\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"c3d73ff0edb681b9\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"49057782f2631e1c\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"754b34e36e0b3b56\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"8c4c38c00ddb6c5e\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"2414d884e9824b9a\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"815f3927268a2ce2\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"c5c85d5edd57ba98\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"d89779fa2ea9a393\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"fd7f23c01ce6fff6\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"aad494133a7fd1c2\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"9bfaba39d8534013\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"16d6ea23d0ac2c4b\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"24742880468efb5f\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"a9da48a53a2000f2\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"4f7e816368a3b263\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"47004eb6c965c94c\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"2e9582e78577d3e3\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"5552f9b82a4be567\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"14cd6047ed256f21\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7a116754ddbb37f9\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"c287b2f5a25de48b\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"8f86a3c49119d1aa\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"b7a1f404ddd979d7\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"6921b193b6df8737\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"3d07c39d1e1277c1\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"b979225ffd6ccbee\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"a4f86321389aad2d\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"84ddd60e8b775e7f\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"fd4ea43197fc0bdf\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"800011b1dd479c61\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"481af5edafbc738a\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"fd23c4a92f4940de\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"00168caf64e46858\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"4eac0fc89e70ac25\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"48337ee35dd0ab4b\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"7236b8a2cfaf820a\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"f7a3195fee6ad4f0\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"c39a26c49291754d\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"d87d584919136b8d\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"82fcfabe32280bb4\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"a4ad07aa466466bd\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"c0600c3d502fa6e7\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"9f9b0ff8fbc250e4\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"e58340347bcce424\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"94e6779df51a7172\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"6d48c7208974c715\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"3b32ec203def41cf\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2d4dbaa01fcdbe42\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"017cc57c426f070d\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"690d5533faef57ee\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"b83b928a67f1239f\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"d79f5c2a7f3d9be9\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"5a4e1231eb72f99f\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"d9cfef3ddf1e7888\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f7cb65edd44cf320\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"a051c8411b5c04f2\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"b3185c96601e755d\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"2d6eb0a0b2d2e7d2\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"4cdf377b60f5a1f2\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"73b93510bb31f075\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"a1f91792d16d8411\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"feb9516af7abb107\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"a86f52c3e2da7117\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"bd36a1961ce6df8e\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"c7942453f1051842\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"a502190f4276d958\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"3cd650907e7475ab\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"3965ccf2c2daf410\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"affd62b7702d5562\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"1ac2d9552601c72b\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"fd8b193c1e8a0143\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"539a038b745a2c58\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"14b4b7a4a83b5abc\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"7097b75208de229e\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"7724f4d5b3a81d13\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"2102ba1264f5b7b0\",\"/knowledge-medium/src/plugins/geo/index.js\":\"6785a0000e811119\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"a92893bef342516d\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"75b6f1e1fdcd15fe\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"286128031fd88e8d\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"5e2d6726fa9c28cc\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"b96cdb11a4126af7\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"40b18eff742e3489\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"815665e6b27387b6\",\"/knowledge-medium/src/plugins/geo/query.js\":\"66a074d1570cd384\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"380cce1e3fe8a8ca\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4d6374272285c67f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"015bdf72908e70fd\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c357e4f256804a07\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"ea31915ae26a37a1\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"7d84af287ee07209\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"77cddd20eae7ae05\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"cdf50450309b2233\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"2a800c1d5fd6b8ec\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1a0f3dc00f8bc043\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"49dc89861bcb4115\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"b26b0efbc6350080\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a4c1f9165c71cfaf\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1b7bafb22b83abbf\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"299586accda40327\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"aa5fe8556981b0c3\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"6413a0687ec8daca\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"702f01913cde3760\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"4732737b2c1807ee\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"06d5682cf1db71d5\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"8e2388a76820a1b8\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"23ececed0429bd1e\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"b0d49d5a33705442\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"2a6d3806ee17e636\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"5a53002ea291e72d\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"a47123c4f3d8a421\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"0481616f6dd40c76\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"455e32a781bc21a4\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"c465cb6b9bb87948\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"b9de2f9b7a9153ba\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"22f0934e2ac08189\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"ec4b4e1dca3e8d6d\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"d4be678ffc257ead\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"12e363bb3e47e367\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a721df2f8586e52c\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"a455ddd2d113e967\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"918092a41f4d7dac\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"46c8c274e35b8ff2\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"969064bf59e4bd1f\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"a8bd6893c649c3d5\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"1967fc6ac62b11eb\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"44b90bb0678e213d\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b3ad2814b95b6cc4\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"c4cd79db4349a082\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"8924e0746d5d38e1\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"0f66bf12d70e90fd\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"171b44760b9a8f7f\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"27ece2b12b6c4ad8\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"2727b6b638fb1b37\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"63233c97d77f4644\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"bdd352b8bc166978\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"f13454aef211ba74\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"150d8891ed003545\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"e951e668853b690d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"5ad391860b1cedd0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"265c46f161bd6880\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"de3d960ce6aab62d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"0c1449c3bc8e44d5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"0aaf6677b0f2e832\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f2937814cff32183\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"69b766c7dfa82245\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"4f630f9bef62b805\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"280ccb81ff7822a2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"a6f60ecbc5ca9fe9\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"902f5195e75a55c6\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ac46f42228110c2c\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"39513895fd93b67a\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"bbe800dd824acb5e\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"4ffb2aaca8747bda\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"c9543454faac8863\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"4d9c7263dfdc3323\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"85ae0f3fc432b0a6\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"b008011e1bf58a90\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"6438fb387e3644fb\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"8ff6fa280f513415\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"8ce04e4e27b70178\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"b1104957120b67cf\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"b7ae0a8e90e056af\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"80e5c709e70ef39e\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"4b863d112b9b003b\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e237aac951451bf4\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"ccc92d5e18c75b9d\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"f9e9ec706aeb650d\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"55ec40e129a7734c\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"299d6d952664ab2a\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"a38840a1ba6e84c6\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"fecd62a93a0f4947\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"3cba01e32a93de49\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"cf30e2a5615947e2\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"fa2afe1c487270ae\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"ebdb829cea3f1c6f\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"c4fe94663909991e\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"7e1445f1c5511522\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"69e4acbd680107f8\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"637a483fdfabc664\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"7fac608a18928be4\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"dbac81a391eb071b\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"9bd2bf7904e4a49b\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"c7e86f56fc1902d4\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"e3f8ba7bfc2e7187\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"46b40dedb9c0c53a\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"340f3ffa1f331959\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"a1f6fa660b8ee791\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"547dde76ae2bd1ea\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"51ad485b524c0090\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"8b9b4e8008782ad0\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"3ffb8065edb07f50\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"8a4b70f1036b6097\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"cc14151c5e605e8e\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"678babf9c81b67d6\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"088bc55a90fa95a5\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"ad9c5394259ff1c2\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"6e82fdaf67f912fe\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"e8c877166f1d181a\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"4ea3dff1b27b1164\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"853f51cd428c5f19\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"3a45ed21a9b2f5d8\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"70c3e1cf4b73cd09\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"3db4b32a809c89c9\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"19b28efadf9e1465\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2e40cdcbb26f05e2\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"237b2754fd8fcd39\",\"/knowledge-medium/src/plugins/recents/index.js\":\"0c77e9d2545de1e4\",\"/knowledge-medium/src/plugins/recents/target.js\":\"ed8f237df13e3ecb\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"7bde8cf2c4a179d4\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"18d18a8af44dccc6\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"40c4283e8a8e78fc\",\"/knowledge-medium/src/plugins/references/index.js\":\"1fa3dcc92f688a1b\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"736040e2a1c97ded\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"3cb96c21d8dd46d3\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"abb23836418ad273\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"c63941f63bf0b304\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"9ff54c8d3fdf7f63\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"2d33cd66e49d018b\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"70be714309daa614\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ec9573e02831d383\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7760395e1a071b0e\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"0bd1b4d0f3803cdb\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2b307ccca3bcd195\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"9b8f734c00341053\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c083f9e908d39236\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"8a892569db43ca03\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"c6b4ceb0966cdcd8\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"5bb8576857bdc78e\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"91e7aa0530b099ae\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"bcbfb45895df2ee2\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"46f96c2eb292478a\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"433525d112c6e69c\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"c9be026109e19208\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"86b5ccb5ad263439\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"5eaa7124d31e71ed\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"e099c1e14f027882\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"4a5e59111c45dd5d\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"ccbbf94ebc1d08f3\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"b20d25c221186568\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"cadd821e2c6506a0\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"20d45db16252baae\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"10e91c6ba830584f\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"f2465dffd90dfaed\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"4c0dc79615da5033\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"10c40117c69d2ca6\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"c89d789d9824cf8d\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"dd39f553f049ef03\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"1fc361a66d924036\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"bf8722dbb66eea22\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"16aa9368f09ba174\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"ef05e2457dfd05be\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"d1ac0b5282a933e4\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"048bcd2078515e41\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"241195630b71c5dd\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"62dd28fbbf9e0741\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"72db308324d1fcf6\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"7fdf466497a025a6\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"c03e7051e5d32a7a\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"d2a75ad1c3d321c5\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"2a89dbe9985951d3\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"ab6d3fc2dbae9690\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"30fe0e34f4305e2a\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"ac852e82e491e56b\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0793f648d38de39a\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"c34af30277c566d9\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"b15c43e02fc758db\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"97cb67f520dfe2a7\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"c535a8c886466edc\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"22bb9e753d548e48\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"68224de7b36095c9\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"c7a7e2350d435651\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1363eb311e4ce54d\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"f03de367227426d5\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"100de485a3ce1a40\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"fd630539584753cc\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"290b121d2bf978bd\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"4e7fabace64892a0\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"21fdaaf0033c7edd\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"68e21d55e5a03612\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3d01161118fa30f2\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"54d01466684b89ec\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"258f68dff7b5a55b\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ca86ac13bc51bb80\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"60c8386a958f8f51\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"60368d064281b779\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"eed35c2cae7ca026\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"cea97d9d2e9b6bae\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"bb0af42558f49e77\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"ca4deb1b348bea97\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"d78b19648eebd20a\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"e62d5e506b483cfb\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"0825fde25b487c5d\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"f605006eb5a33f0f\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"31d0ad7f2d5e6614\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"4529ee43a7debec2\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"7c01cc522d6ddf46\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"eee983bfd3c7a8df\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"1840f00727bcc0d6\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"e51b1ef8fe46897f\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"176a9f41346ee121\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"7cd0ae58a3d617ee\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"719c81b02a1891eb\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"42221696e19f63f3\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"c897510f9bc309e0\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"ce4d0c8289ae5f76\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"f24c486f1bcd352d\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"033a3b91934a65d2\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"d2cc614b99b8d7df\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"de50190ca4241a7b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"97a2732e99b98cd5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"eee026fc78f9a6cf\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"2c0ea97fd6a98dd6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"e33f4473d5cec2ab\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"c6eda420f9838721\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"03d0d02b224bf451\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"564c933126e8a485\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"db9088d3a2bb4b9a\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"b1fdca010b2274e2\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"9d0e466ead54b0fc\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"3a3fecbb4e1decc9\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"381492f1260864b6\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"1749ab0e318be896\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"5a9d705a610b009f\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"ae1d4d059df28c90\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"ac7e387bb01a8eac\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"df99a6ae1a14997a\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"b7e2522eed165fc5\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"e1e1328dcd386944\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"6f8bd65cf1e5b488\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"3c4283128d403a68\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"8fd52fe4f4801b78\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"f980e5a68890a7e1\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"b590b4e4626c6e73\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"4d09880b4675a8ae\",\"/knowledge-medium/src/plugins/tables/index.js\":\"c3352f6e158489fc\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"de1ded3d542d9a2d\",\"/knowledge-medium/src/plugins/tables/model.js\":\"35db51650d01b092\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"39815a522b837c3c\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"baa83afac7074b33\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"1affcf737a1f3d6b\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"3ddea4c59c152021\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"7cb826cf485f85eb\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"40bbca4f7f1fe6e6\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"0d497c3098eb0167\",\"/knowledge-medium/src/plugins/todo/index.js\":\"232eec63ba93efb3\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"420e15c16426deac\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b491da7dc720ec9d\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"fac28382d56ff0a2\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"6bfea0c6d30a8322\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"09efcc6d700f5139\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"77b0c9ae089c68a6\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"c0d28cbd190b4ecb\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"74aa67025cda9d92\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"2b891fa60691fe96\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"6463118d27d46cd2\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"c4059a7761b7fab6\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"54a11cba0fa60f0d\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"90236666131a081d\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"536a7a7acea9b1b1\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"45ee48d3d99151f5\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"def42590bd6831d6\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"f2779efefba82a88\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"2791339c276ede83\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"2f5eac5d1dfeae3e\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"502758b03245157f\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"2f8318a3ad70fe60\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"212804627de638fb\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"457834b1e407908c\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"28f30443a891fd5e\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"d8e9e2b4be066621\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"d20c05f0f3130d5e\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"3f8823c2783325d8\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"208bf54a949ed6bf\",\"/knowledge-medium/src/registerServiceWorker.js\":\"587b678499ae1d79\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"0c3915221c5a945e\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"4566044612752bb4\",\"/knowledge-medium/src/services/authStorage.js\":\"9f2810a55809f99a\",\"/knowledge-medium/src/services/powersync.js\":\"91357673facf6322\",\"/knowledge-medium/src/services/supabase.js\":\"3d9e713208162fce\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"1b3f6d8218304b8f\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"32039c1c2b819c4e\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"f8feb39dfde14e89\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"42bf58cc82b8d37a\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"5c69b239f6f27f5f\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"78c3847581e3b588\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"a65e535d26237fb2\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"c2a975f0515fa927\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"6fc1360558a2f569\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"f23d0f928a5840d7\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"c120ed0b356d4f90\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"b83af0543bf17f42\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"676cf3e8698b6d87\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"550524eff77662c1\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"c40c85d08826b824\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"0592ef84fff0723a\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"f3efea8c211860e8\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"5eaaf4f0acc38df5\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"52fa137e2762005c\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"a498647e172d0ffa\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"47f6f712cccb8852\",\"/knowledge-medium/src/shortcuts/types.js\":\"e37edfe74c70f813\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"f29f093c2fd38c77\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"630fac13c9ca33f9\",\"/knowledge-medium/src/shortcuts/utils.js\":\"b5ff85d9b0a16ea2\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"40e6ab167483b973\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"3b25c02808f4271f\",\"/knowledge-medium/src/sync/byteTransform.js\":\"8a1fff8b496bdaa1\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"da9df8c3ba6da4f5\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"4f37aa59f9deb022\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"c16c81672851330d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"ba24dd830054e11c\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"851b82ebeaf235d0\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"1d815109deba931d\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"994f177f3d6c2920\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"d2d8d611bb955a36\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"313a844f80e8dd90\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"ea63ff123c373993\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"24322293181fd4c2\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"c9eeff6babef0d82\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"94e197cb031a05a2\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"0cd6fdb2e841b5e2\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"a35f31d3ebde28e6\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"7cfa3aa399fab9ac\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"c7503b4fdc32d4dc\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"bac49199f8dfe130\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"546ee37dc1017900\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"daebeac3a0e0b8b4\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"fdd28f5f710d4002\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"369a2342a5f9ff2b\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"20b3f7193d19bfa7\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"8171ba4981b68fe3\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"5e5a50d6281ccd99\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"6a653cf170d83028\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"22aad1203fbc5921\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"24ea00702e25d468\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"c820690ff4fe5f0b\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"87fb7628d9b46420\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"258f4cfdaeac0e4f\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"4f52fcc571c91459\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"b7512ef5902cefc2\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"19cb0040e6abbee9\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"7242454fc9e0c943\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"0b416376e5d41ff9\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e4f8a636c13760e6\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"cb7c5f2368389e2c\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"d4491ff5acd84049\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2f6e5df42f757627\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"4136f36c841b364f\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"0c7ebaad14b08af8\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"9bd6ad9a592b0ad6\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"f59ed64e34e184a1\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"495fbe4c5adb5cbc\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"52a6736a6cecf58d\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"b87bd11fdbc63e4d\",\"/knowledge-medium/src/sync/transform.js\":\"eac14b9285502c8a\",\"/knowledge-medium/src/themeBootDefaults.js\":\"6973a917bfb793c3\",\"/knowledge-medium/src/types.js\":\"66ec838ca3ed29c9\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"0882b055e19ec9c6\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"d20a7f9757ae61e9\",\"/knowledge-medium/src/utils/array.js\":\"b196ec8680db991a\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"5f018fc2f01018ea\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"39ae6a206605a4fe\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"ef371d83bca655dc\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"ef435db0815f2c1f\",\"/knowledge-medium/src/utils/callbackSet.js\":\"42d21050e3bc721e\",\"/knowledge-medium/src/utils/clientId.js\":\"2de52c9c09f9de81\",\"/knowledge-medium/src/utils/codemirror.js\":\"c98a067ab63dc2a8\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"6b560e329834fd3a\",\"/knowledge-medium/src/utils/copy.js\":\"78333b8c1cf72982\",\"/knowledge-medium/src/utils/dailyPage.js\":\"8fbd0a50141b34b3\",\"/knowledge-medium/src/utils/dbForensics.js\":\"8b87f8c0b436fd9c\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"1da9fed9cf477183\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"e2992d6a9c881165\",\"/knowledge-medium/src/utils/dialogs.js\":\"ca787db079ef0ccb\",\"/knowledge-medium/src/utils/dom.js\":\"5e642f1bc2c118a2\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"00d8233c2aa57584\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"83742ecfc9e2827f\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"2096d8b375b1aaf2\",\"/knowledge-medium/src/utils/flipSlide.js\":\"8be30e1402948fe5\",\"/knowledge-medium/src/utils/fnv1a.js\":\"43835edbbdf7cff2\",\"/knowledge-medium/src/utils/formatBytes.js\":\"6e8ed66ca04b4194\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"8b54765fd2138526\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"fcc137595d2a0f90\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"5c290d8b278eeea2\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"525b5e53990b17ab\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"1cfcd0d2df1b6406\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"2e19383385393b02\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"9fe00e2a32983393\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"fd60fb0ed42fdc4a\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"186c47ac9d16053c\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"9e3bb4a72c6760ff\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"ea369e7ca7088045\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"31b11537e4c30d72\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"20dd34722152494a\",\"/knowledge-medium/src/utils/markdownParser.js\":\"c04de67888b8a4c7\",\"/knowledge-medium/src/utils/memoize.js\":\"6f4bffc6bd201894\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"016af3aeae400d04\",\"/knowledge-medium/src/utils/nameList.js\":\"d9c9b50ae2675ee1\",\"/knowledge-medium/src/utils/navigation.js\":\"4ddc5d10407e856a\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"2112cb4ecc611147\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"dc9102002d75207a\",\"/knowledge-medium/src/utils/panelClearance.js\":\"f208f4d0272f5fcb\",\"/knowledge-medium/src/utils/panelHistory.js\":\"1a572f38a9b795ee\",\"/knowledge-medium/src/utils/panelLanes.js\":\"996b43573654486a\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"8dd57ab5e4420c9e\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"4250da4f16ad3750\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"fef0e242725b3b74\",\"/knowledge-medium/src/utils/platform.js\":\"a2e914dc4e194744\",\"/knowledge-medium/src/utils/pluralize.js\":\"fa96d21457090154\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"44eec38065709355\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"57c20b6fe2fe2fa9\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"49052294216b16f6\",\"/knowledge-medium/src/utils/react.js\":\"05b55af8b196638c\",\"/knowledge-medium/src/utils/relativeDate.js\":\"ac5661ab3e228220\",\"/knowledge-medium/src/utils/relativeTime.js\":\"440f02539d858ca0\",\"/knowledge-medium/src/utils/renderScope.js\":\"24d6504f3e428a5a\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"db6afbb1c0754ea8\",\"/knowledge-medium/src/utils/routing.js\":\"b958470ecd48a0af\",\"/knowledge-medium/src/utils/safeMode.js\":\"cf689c7ef61dc2ba\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"9e83b656ff2eff85\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"335ff911dfed46e7\",\"/knowledge-medium/src/utils/selection.js\":\"d8245cf39a1dbcc0\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"55b58f00e6d52881\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"97b36053098240cc\",\"/knowledge-medium/src/utils/state.js\":\"4a3de2485bfa5a43\",\"/knowledge-medium/src/utils/string.js\":\"3e45d7fc0a2dfbee\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"372f73941e146bb4\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"90f7f5b6977d4810\",\"/knowledge-medium/src/utils/toast.js\":\"9d2920ee053f1a23\",\"/knowledge-medium/src/utils/toggleStore.js\":\"e120ef95dea218a5\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"03729659c97b5f4e\",\"/knowledge-medium/src/utils/userActivity.js\":\"8945c6f0f6785502\",\"/knowledge-medium/src/utils/viewTransition.js\":\"a60f63a170d14ddc\",\"/knowledge-medium/src/utils/viewport.js\":\"5d305b1b06715093\",\"/knowledge-medium/src/utils/webLock.js\":\"32b0a1cfd3ccba7d\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"85785b5a46aaa53e\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"3163bfd7d460cdca\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"af00a1978bb23d23\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"eec80ebea68366fc\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"9fb44fc6edafdebd\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"b5cc81465104f9f3\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"3a6025e8b8c41a89\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"d34ea26a515da76c\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"38a77f6a9cc3b31b\",\"/knowledge-medium/src/vendor/react-dom.js\":\"00ad36c319fcdb25\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"e6fd570e6f694b16\",\"/knowledge-medium/src/vendor/react.js\":\"8fe4412d2f638ac6\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
