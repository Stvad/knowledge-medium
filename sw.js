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
		buildId: "f3bbb24e5ba2-fa29b36e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"94b8bebf17c140df\",\"/knowledge-medium/index.html\":\"94b8bebf17c140df\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DwewRQxW.js\":\"ad6876eca64f33ba\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"7a2c761e22361705\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DtPtEoUm.js\":\"48d130ad0a3d2cee\",\"/knowledge-medium/chunks/FacadeVFS-e3eOl44N.js\":\"59612c34115347f9\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BFonHvkp.js\":\"cea30f7e06523f7e\",\"/knowledge-medium/chunks/MemoryVFS-BDId3nne.js\":\"772d02b73d05096a\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DdB3neyD.js\":\"2ad3db34401ff7d6\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BKPEmKAq.js\":\"877d7a52e4568057\",\"/knowledge-medium/chunks/Preview-DtWLMXkH.js\":\"f3c1ce291f8e16b1\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BbO8C1Su.js\":\"27989abfaccd94aa\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-Bc-U_0Yj.js\":\"2817ea698dcc940a\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-Bm9YGbUH.js\":\"0ea89702e6332bbf\",\"/knowledge-medium/chunks/react-CIz8Abke.js\":\"9dadd63cc9e594c9\",\"/knowledge-medium/chunks/react-D257iJg6.js\":\"de9e3b3e8f5f4198\",\"/knowledge-medium/chunks/react-DG5bfCRL.js\":\"b9ef0dad8972e2f4\",\"/knowledge-medium/chunks/react-DPFR9SIA.js\":\"4cf310ca2bb13318\",\"/knowledge-medium/chunks/react-D_S3KuH0.js\":\"585a30a3981c8c8f\",\"/knowledge-medium/chunks/react-DcUGZGkO.js\":\"0787a2c4815e5dc1\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BS5kkz6F.js\":\"8c5ece3e760ae486\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DE3Pwz_w.js\":\"fadbe9bb732e6fd8\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DypFHtCU.js\":\"caa801853a1dc8c7\",\"/knowledge-medium/chunks/react-y2usug2v.js\":\"3ac8c26e139a3805\",\"/knowledge-medium/chunks/server.browser-Dh-9YvuC.js\":\"ccca5da87c41c6fe\",\"/knowledge-medium/chunks/textarea-LARWyltS.js\":\"3428f631ad80aac4\",\"/knowledge-medium/chunks/ui-M2CRmo_J.js\":\"dd0ad7a9b633915a\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"5cfff76f10d9b6cf\",\"/knowledge-medium/src/appUpdate.js\":\"4cfce6eb5d6e5818\",\"/knowledge-medium/src/appVersion.js\":\"3e1a271594110e48\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"7e787b0812ef30fb\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"6644cb6d342f7aa8\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"301aae42681f5dc5\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"40aa20d883166c6c\",\"/knowledge-medium/src/components/BlockComponent.js\":\"d94f608a68e66168\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"26caf0aded96b1f9\",\"/knowledge-medium/src/components/BlockEditor.js\":\"778b5116bb745a30\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"d4ad0355b5f8fddc\",\"/knowledge-medium/src/components/BlockProperties.js\":\"a2c4d72a93443e3a\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"9790b81b2bf0d066\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"2573af10f1d4cc93\",\"/knowledge-medium/src/components/DividerHandle.js\":\"acfa8fa6442dc02d\",\"/knowledge-medium/src/components/DraftEditor.js\":\"0bab1be0091cd36b\",\"/knowledge-medium/src/components/GutterPill.js\":\"7f2a7dc8bb046394\",\"/knowledge-medium/src/components/Header.js\":\"08b64efcbf1fdc0f\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"97fb99255d5be800\",\"/knowledge-medium/src/components/Login.js\":\"17c90396bafa185a\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"c70d131161e32532\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"4e775121c35d9091\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"572b50cbc8a2a3f9\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"eee888d920a4a77a\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"16fcf1f540fe8f5b\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"4e484f5d350242aa\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"e6cb7456bf513e15\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"dffb6183e44ae8ae\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"2152a286d6956657\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"03c1804598aa414d\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"bf84cee0fd5c43db\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"499d29cc186f4e48\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"7b3f0e320e9c464b\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"d464b6eb2144a928\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"d53a549afe79b1eb\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"7aeb9c3ffc5f46bb\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"e6832ab05de48a42\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"7f440ce6102510df\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"8f5b615ecc353b0e\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"402b2314f0b262e7\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"836ab5bfaabf90e7\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"926df1839dc4c10c\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0450dc085a3cacbb\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"1150027d631af8df\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"b2f4b07b829e4132\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"9b4251955fa90018\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"ec7c390a83064926\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"d4b00a0f397a6481\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"0afc638885be3a52\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"443fcb2a2b26ecdb\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"20172d4604d893f1\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"288816f8d0bb56b4\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"130df9b616d2e614\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"0791c01589dc10bd\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"e91233e5ceafa212\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"74c3bfbf7390b056\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"12ff8da5fc7501e4\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"a7c05402d02b0be1\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"3729a8331ab9e745\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"48255f66721c977a\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"f439fc57927ecb4e\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"68b9e6e569cf8423\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"8bc2c5e1cb815a1b\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d00b0f9f41797d8e\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"e1ff60f68f50cee0\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"64cc7d7c6dacfe6d\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"db5964cff72ac0ff\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"3fd789e8a014213c\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"812057c47d901cff\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ad601e1ee9ba217a\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"812feaf94691f75c\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"04429e98f5e5a4de\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"bbc86813eaf29848\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"af374dca1458f721\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"a18b00e30cd3eb74\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"1bbbb463c99b01b9\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"411d3869b3b5aca4\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"f94908a5f00c3d45\",\"/knowledge-medium/src/components/ui/button.js\":\"34dbdd4254dc4d9f\",\"/knowledge-medium/src/components/ui/card.js\":\"bf5819626ad31953\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"2cd4d02fddbe9a0a\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"2d6fe3f11599cf12\",\"/knowledge-medium/src/components/ui/command.js\":\"b0a3aded342890f3\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"ee9ca1c4ed73a873\",\"/knowledge-medium/src/components/ui/dialog.js\":\"59b63d6cb743b846\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"5d6a25f6dcceab83\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"af8232ffeeb0821b\",\"/knowledge-medium/src/components/ui/index.js\":\"a0789d1f025dfac4\",\"/knowledge-medium/src/components/ui/input.js\":\"38a3809f7914b8c7\",\"/knowledge-medium/src/components/ui/kbd.js\":\"3501569619170485\",\"/knowledge-medium/src/components/ui/label.js\":\"9fd14aa9de03ffe6\",\"/knowledge-medium/src/components/ui/textarea.js\":\"2f33236666f89eb6\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"e0cd5467ac94169d\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"1ca6e56395d62f71\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"64f364c4eb8fca80\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"72fa8dfe6ad5649b\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"4a9be60ec326f6fc\",\"/knowledge-medium/src/components/util/error.js\":\"c55836ec1a8c412f\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"9613779b0c6cd174\",\"/knowledge-medium/src/components/util/suspense.js\":\"b83e4903ba2df761\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"d714f05bbbce41e0\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"cca083b91b6a7e36\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"7f7c1580f347c2d6\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"fcd369a7d39ca86c\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"847089d780adc755\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"114e916955d94693\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"fdd59f6ad2fca875\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"4e449c26febac79b\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"a26b601c4fa9fc9d\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"684bfada9eb951a5\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"b0604baa2c6f1ce4\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"f904e5070fbb12b1\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a88ff24f509b672e\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"5ec2bd57bafa8c73\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"3e99a855ef51b7a1\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"8b2d31fa717d8b15\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"0602fb6637b13cfd\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"96b48db665054a94\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"5570fb8e3b997eb8\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"2830342984745d97\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"bd24d8aab9b8d738\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"fe2097005cfaf549\",\"/knowledge-medium/src/context/block.js\":\"41cd548e96a744be\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"b2e3d3d1d0cdf3e8\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"45c3b6b2d6acd08d\",\"/knowledge-medium/src/context/repo.js\":\"0c7a6a0bf02d8f77\",\"/knowledge-medium/src/data/aliasClaim.js\":\"95a4894fa7105a7d\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"7acbd2575aded810\",\"/knowledge-medium/src/data/api/blockData.js\":\"ab55ba9f67587a09\",\"/knowledge-medium/src/data/api/blockType.js\":\"033712f0df496ab9\",\"/knowledge-medium/src/data/api/changeScope.js\":\"0e9da8f18811a129\",\"/knowledge-medium/src/data/api/codecs.js\":\"2779b9cdadf86694\",\"/knowledge-medium/src/data/api/derivedData.js\":\"3e27eaafa8e083e4\",\"/knowledge-medium/src/data/api/errors.js\":\"876a68882380c66b\",\"/knowledge-medium/src/data/api/events.js\":\"e962371938ab45f7\",\"/knowledge-medium/src/data/api/handle.js\":\"9822eeea4780251a\",\"/knowledge-medium/src/data/api/index.js\":\"9d967bf57972acf0\",\"/knowledge-medium/src/data/api/mutator.js\":\"acd1328332896964\",\"/knowledge-medium/src/data/api/processor.js\":\"e075ddfda4d9d91a\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"21b84612c1e5ae79\",\"/knowledge-medium/src/data/api/query.js\":\"30ddaf8e83f0dcfc\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"4aafcdfca40f0cde\",\"/knowledge-medium/src/data/api/schema.js\":\"9822eeea4780251a\",\"/knowledge-medium/src/data/api/tx.js\":\"9822eeea4780251a\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"5be843690a5c454d\",\"/knowledge-medium/src/data/api/user.js\":\"5cd3895ee3dbc866\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"d5366a940137905c\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"0c6e37b0ec105c58\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"38bcfd94a58d4032\",\"/knowledge-medium/src/data/block.js\":\"6d7cc02fbb2f7be8\",\"/knowledge-medium/src/data/blockCache.js\":\"8a2dc61d88096f44\",\"/knowledge-medium/src/data/blockId.js\":\"277bbfd212f43f79\",\"/knowledge-medium/src/data/blockLiveness.js\":\"372470fbfa5285b3\",\"/knowledge-medium/src/data/blockMerge.js\":\"16ab87d84ccfd45d\",\"/knowledge-medium/src/data/blockSchema.js\":\"60c67c9b5487b394\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"508960e3b4eb741d\",\"/knowledge-medium/src/data/blockTypes.js\":\"bbe2812a5c952529\",\"/knowledge-medium/src/data/childrenView.js\":\"cb67654ec5208730\",\"/knowledge-medium/src/data/clientContext.js\":\"244419e0faff3667\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"91cc4f7bf40f1989\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"5ed956afa5000e60\",\"/knowledge-medium/src/data/derivedIds.js\":\"04fac9cad9a63649\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"d0e8809eb847807d\",\"/knowledge-medium/src/data/facetBridge.js\":\"eea1749751b82644\",\"/knowledge-medium/src/data/facets.js\":\"288dd14ec31d864d\",\"/knowledge-medium/src/data/globalState.js\":\"40dac23e320159b9\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"05c682735054ed2e\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"24b29fa9bd1f2e24\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"9849e96dcedd06ed\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"18225107a4cc711f\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"2aae9282610128c2\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"b4caa431d7a5c3c3\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"603208ee4b66a748\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"218c86a84c52c134\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"72785bcd3bdf2703\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"f2b93b9c35864843\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"bff8aeae6c55ef09\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"acae3b6401f07995\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"0fe922056c5b4659\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"b87e996712f8f39f\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"cad5d3b5fe8fb504\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"5311e458bb467f00\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"ec01bf90ffb9b9d7\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"99a5817094fd4f4f\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"4cdfca6fc0a93eb0\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"4e040d2335f97c0a\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"e6ac905ada5f3ca3\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"f66834a3e14c84d1\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"6aaba6eedc5e318b\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"fb6e358d46d00cf0\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"18be3da8b879f8ed\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"eb562388fe84d514\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"568cf2b87abfa36a\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"f7867e49e34cdad6\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"57bd97a5658dee95\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"de2a020b3eeded30\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"00321410af3afb07\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"798d98e750c7ee50\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"9f2a6daa1722dea5\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"3b1e0d50dfb28e94\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"7cc10c458fb57707\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"c374f5b510c23856\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0744dc894fc5182d\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"d89dcd8184b0615c\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"f916ec5be1c518a8\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"8b37185dc85280a1\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"c9de659c5085c27d\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"1aeab397a94a22d3\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"d9296f69391d180d\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"149a54817200fa96\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"db396648938a754e\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"2762bb88bc363fc2\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"a1dc28b302ce6366\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"35eb169f3a6d73ab\",\"/knowledge-medium/src/data/invalidation.js\":\"e18594d698b6b9de\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"d80a525befbebf06\",\"/knowledge-medium/src/data/kernelPage.js\":\"de1399964ccd3c78\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"37977a41b2b40618\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"f5c7c7ac38b67468\",\"/knowledge-medium/src/data/localDbStorage.js\":\"18142c140aedd631\",\"/knowledge-medium/src/data/localDbVfs.js\":\"11f1c607393a4042\",\"/knowledge-medium/src/data/localSchema.js\":\"231f770e77c144c0\",\"/knowledge-medium/src/data/maintenance.js\":\"472f5f6193ad30f5\",\"/knowledge-medium/src/data/mergeProperties.js\":\"603b5f17c2d446ab\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"ecb3fa32c3501008\",\"/knowledge-medium/src/data/migrationsPage.js\":\"948952962da03ef5\",\"/knowledge-medium/src/data/mutators.js\":\"f54ee5945921e206\",\"/knowledge-medium/src/data/orderKey.js\":\"0e80ba747287c814\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"af15e8d4a11c2b08\",\"/knowledge-medium/src/data/outlineSurface.js\":\"fc06fb5591f89e34\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"60247aec9f39c3d7\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"da6cfe17d0f30a51\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"341dac97b4f22cb8\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"fe7debee3ecc3521\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"edd3a7b5a93e6ef5\",\"/knowledge-medium/src/data/properties.js\":\"9ddf796bcb9505e9\",\"/knowledge-medium/src/data/propertiesPage.js\":\"1728b378f1af7f39\",\"/knowledge-medium/src/data/propertyChildren.js\":\"427097e5a6661c0e\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"6ab8d8c12d52b48f\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"dff048bd8a43545d\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"ade7200b7f07d05c\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"9475dc74c3c5ae50\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"1a6ff536bb507aad\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"adc6e6d108711984\",\"/knowledge-medium/src/data/propertySeeds.js\":\"0fc726fb3893c9a6\",\"/knowledge-medium/src/data/recentsPage.js\":\"7fc07d78c92d3b7c\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"430ef05558e2002f\",\"/knowledge-medium/src/data/referenceBlock.js\":\"8801094e28bb4671\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"940757fe42ec3025\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"230df7e9844beb7e\",\"/knowledge-medium/src/data/repo.js\":\"36f1ecd4165c1b85\",\"/knowledge-medium/src/data/repoProvider.js\":\"04a53d55a8d23c97\",\"/knowledge-medium/src/data/rowProperty.js\":\"56a18ac7efc1870e\",\"/knowledge-medium/src/data/searchFilter.js\":\"c1d8c02dda8ba2af\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"28f19a9cbac6d3a6\",\"/knowledge-medium/src/data/stateBlocks.js\":\"605bf013625e9df8\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"bb45073956bfe810\",\"/knowledge-medium/src/data/structuralInsert.js\":\"faf35418f16d77ca\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"5eda05187b654dba\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"67a620c4eab190a1\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"46c738a5b4caf9df\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"609ac03202fc071c\",\"/knowledge-medium/src/data/targets.js\":\"16a7c684589ea2b8\",\"/knowledge-medium/src/data/typeColors.js\":\"d885f089d4c79fc1\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"aaf3ee39be24654d\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"9989c2f247c3137f\",\"/knowledge-medium/src/data/typeExtraction.js\":\"bb844a5ba6f8c1e8\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"f68ae30ae041c845\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"052072e51e4f3f38\",\"/knowledge-medium/src/data/typeSeeds.js\":\"5cacfed773036550\",\"/knowledge-medium/src/data/typeTagger.js\":\"d011af3b5a9e29d6\",\"/knowledge-medium/src/data/typedRecords.js\":\"943945c427e139f2\",\"/knowledge-medium/src/data/typesPage.js\":\"53583694af993c33\",\"/knowledge-medium/src/data/userPrefs.js\":\"94f100ff94c64d6c\",\"/knowledge-medium/src/data/userSchemasService.js\":\"e8b564629728eee3\",\"/knowledge-medium/src/data/userTypesService.js\":\"11e3d1c9d6ac8ed6\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"3acecb9647e3aa4b\",\"/knowledge-medium/src/data/visibleChildren.js\":\"a899ec91d24a8bf1\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"f99b94a416e3c452\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"98cdee752693c253\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"942d9dcff74d8e18\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"ed527010372e5b41\",\"/knowledge-medium/src/data/workspaces.js\":\"7b3ccca6bfd23e7e\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"0b1890643cf0a148\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"c640778c83e06651\",\"/knowledge-medium/src/editor/atTrigger.js\":\"3e87041cbe098e23\",\"/knowledge-medium/src/editor/autocomplete.js\":\"1723a4ee29d7762e\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"1c4fb0fb3c4fad16\",\"/knowledge-medium/src/editor/contentFlush.js\":\"d1a8fe9c7204d624\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"b96a546197eb3563\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"30439061152563c2\",\"/knowledge-medium/src/editor/insertImage.js\":\"b8fb38533309ae78\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"c38dc0ae98f04353\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"48a24082344177e9\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"07f8fd9042ac0add\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"0b082ded7e727e76\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"d79032fea4b5ecdd\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"35ec772ab3b63dca\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"f370566046e9edd8\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"6f2fdb5081385881\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"cfa9c793ff22710b\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"d0c885638448a2fa\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"e3bceaf4b509d26e\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"ec3bde0f33dad8c6\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"948766da7ccdbe31\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"2025ea207e4a42f7\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"f3aabfac97bd852f\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"7fa4fee9fc57ac2b\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"88db25fba90e541e\",\"/knowledge-medium/src/extensions/core.js\":\"020942b3a1ff5b3c\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"3a6536943e821588\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"69f8d84ecf4f87b3\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"342f41b916c2b629\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"61d752331e8890dc\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"9963eb007e69320d\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"15d2b17615b47ffc\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"892f75954edeaa18\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"39bdbd9d5aa57fe9\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"7a74232e658ad5ba\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"c038a95afc88fe6d\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"f023ac12b68e2940\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"cc8b1be9814bbde3\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"d67fe4fff1d8bbb0\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"e4367116296ced94\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"204d6044b0bfeee4\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"86b648dea67a29b8\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"eca7056ba42cc805\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"3752c9a57f3b0f71\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"0372510bf789f33b\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"4c2b311cca4872c6\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"ffa2ddf18211e941\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"e811da00dc529cb7\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"1e4bc85b56130c53\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"21ee29e592449cbc\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"3710635d8d12df23\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"39fe9b9eead69b80\",\"/knowledge-medium/src/facets/facet.js\":\"0100f1b4a06ce32c\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"54ef2f442639f6f8\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"3a16426cebd29557\",\"/knowledge-medium/src/facets/togglable.js\":\"5d8d3a7de6c540f4\",\"/knowledge-medium/src/facets/variantFacet.js\":\"02a1cd8158461275\",\"/knowledge-medium/src/facets/verbFacet.js\":\"33c2b3d7fadf1a84\",\"/knowledge-medium/src/hooks/block.js\":\"eb3d54023e4dab5d\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"9fb0439165abdb7b\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"8c59c4033e5c529c\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"27b094bb59976eaf\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"822e5a7901faefd4\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"02d6f1b051570596\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"5acff947550d66f9\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"704b1edb3f8a671b\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"043317fb8fc5dcfd\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"4fda5b4475844594\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"7130db6be7b56576\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"2933f4fd2104e4e9\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"74d6dca1ece1bf35\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"5012fa21b8c918bf\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"73f6cdc1f619ceef\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"bddc78fe074c6ce9\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"e2a27b1a67673381\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"7200f1f63c9a2280\",\"/knowledge-medium/src/lib/utils.js\":\"4dd1d887d2616af5\",\"/knowledge-medium/src/main.js\":\"d81159c2fc007e5a\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"9890aa4a0a26debc\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"79ce57df4c367429\",\"/knowledge-medium/src/markdown/context.js\":\"38be1f33a8b2a6f8\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"3d9b42242eddcde1\",\"/knowledge-medium/src/markdown/extensions.js\":\"5bd497b5a66e3fa4\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"694a90406c5a0820\",\"/knowledge-medium/src/minimal-editor.js\":\"3c7ad3d3c0b497e2\",\"/knowledge-medium/src/paste/armedCut.js\":\"8cc84608901fa2c2\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"600cd84e8b56758d\",\"/knowledge-medium/src/paste/clipboard.js\":\"95bdac6cce29890a\",\"/knowledge-medium/src/paste/decision.js\":\"7a15720218abcaf3\",\"/knowledge-medium/src/paste/operations.js\":\"f1c6fcd86142e359\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"8bcf993a935b3f52\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"63d728d3de95d9f8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"68adc0782fe56d29\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"56db15a97fe447e0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"d95b09e489ff0edc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"c28cd37cbe2600c5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"cd15ac06dd11e7e6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"fd6ee9ab3dbe2b5c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"b568b9c234ac131b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a942f61c5c77fc5e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"1a4b78009b663d42\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"799fe5650b124a2a\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"166d91c4f7c81582\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"742746344f550c65\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d52452fc3369cbe3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"2ba0391205edab98\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"df59b28b2b7de10d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"19dc979355715dab\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"b13e416d9dfb5182\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"4d5dc8ad14b475b4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"76eb92cff8d4970a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"f91a1f69d62e756b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a538d333965aa303\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"0bd6398483151686\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"a46fa0ff6e743d93\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a4fdb82e5068d8a2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"fbd3380c39bf9c00\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"da8b786d438d6ede\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"3c3d764635c27af2\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"0a0421f46150647e\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"784715d308038e9a\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"cfa08a0664e8880c\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"ebeaab5bbd883245\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"d3665bde874f1f7e\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"1a3ec050b35a64bb\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"331cffb4cdd9e240\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"6eb7aaced7a4efda\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"3d52dd2b06dd10ca\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"828df7b672996c41\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"29a24960087468d4\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"a5732e3875dedbc2\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"2fe3787bdbef330b\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"b4282d85cf8a468c\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"ce3a6882083da3aa\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c6c66a7d53ac5ded\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"2e852457c619a52a\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"777abf1f5d905617\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"1452de156d70c0e5\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"d62263d6720cd503\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"13eba4623fdda8ae\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"c6e95f86be60080e\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"c34df5cf6119cd88\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"e79451c46cadaa39\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"5243e28b7887c3b6\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"18ee42b70d2b2a78\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"c1b6050d2a7be7c4\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"0a1434601f6c4d44\",\"/knowledge-medium/src/plugins/alias/index.js\":\"6e31a5349d17aecb\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"0fe9987ce53fbbe4\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"34960945f0c8dbe9\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"2a53d5f6e051b86e\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"d81627870dc92947\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"87d76fcd483cae47\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"5f66f71e7e17bf0b\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"32abdd757c3da018\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"514918ffb299c4f0\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"3fca7bd39be2c001\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"dbd80b6ca01e33d6\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"56f194026e62cd09\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"7880719fb8af096b\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"2644b300cb1ce320\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"b8807e9ce20abbe5\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"91ddc21362a69467\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"e3b94dfc5a33a77d\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"15bc3015a2e369c9\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"adeac189d376b715\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"61345c39d10d6953\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"26a321092073fcc4\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"1f4db20b4802c969\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"bdd5fb9d675c71d0\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"19a467a02d6a75d8\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"b53cf71e39d8f094\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"c441cae30c18295d\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"edbc43c9a188eb15\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"9719798033d64072\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"c7e2e790c8b5d55b\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"2cac8b1ab5b114f1\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"9c2fc29984a5c56f\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"acf6afcdf7e77268\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"b870590666d5d73d\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"41be9c707c8c2893\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"c9ba6ea897b2ab5b\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"ab815b469ec34690\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"ad9c075db6295e90\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"9278b5c6ccd12069\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"cdd7eae0bd86cd82\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"2c5f60c4ac82fda8\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"cfb897dce81613cf\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"6a8201b756177104\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"6cc2ab3d607c18d9\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"b118e7c00b814ffb\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"65f1096300ecc078\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"b0fb92582f6f68f9\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"29f5dfb1b5279f83\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"a99ac23c951a4ff8\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"5868117a71c09f70\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"030ffb74932034f1\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"af4f54e5f38e1672\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ae77fe1d761176dc\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"ece9359edf6ae235\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"f7988043a6930ba8\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"2d7a1e09d92e217e\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"aafde44942f177c0\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"0fee0436f3f66b37\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4c5cc1a6289037bb\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"0264fcdccb2b275f\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"b56726b0b9d7f3e7\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"e95cceaec33a0840\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"d7825a247baeaec8\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"8ecfd8b4bacf9d30\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"707d17ee40430de1\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"112f814b7fa606ab\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"8e535e493bf4ee3e\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"58f435250092da96\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"95b55bca932bd89f\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"c7c673821869cd7e\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"6557f84ba06bc245\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"3714d56c879b53dd\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"6e755081bea5a194\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"00a5ff534b517e12\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"c730374e0c7198e7\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"a47fb2f14543f7b1\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"8af497b54ddd1c02\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"80e38cbf0154d18b\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"731cb530c66a8aca\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"69aea311ba85114f\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"1fd2d42baebe3413\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"b725fea891b04c30\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"3350587c8ac949b5\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"1665c1d0b7e60345\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"8a4ae71f6f52663d\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5c5d1446651d6a28\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"29c58ffbce3ccabc\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"55232d9d135a22d4\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"93f28c7e289d1743\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"68219a481a32de60\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"ed3eed7062bfda59\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"75bdd3d7005d2fdc\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"5651253a0775b017\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"7774e58f43faa8fe\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"638b724a833db596\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"8c1c087f11a53adc\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"73b1a51a64356441\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"562dbfb7190a05f8\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"9c3d1d93676547e1\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"30fb81bcfe50aaa3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b3be96815d4309ff\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"792d5ffa077b41fe\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"e53a404bc28b9254\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ae3b4f8312e298da\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"e6de281fbf1b1aa0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0f7a3f6596ecb530\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"bdfe1ec40db505d6\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"c7c3b1458bfee61b\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"4f837ffbb823a9b9\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"c2965b4225e484f2\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"fd37123c940c36f2\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"0eb6770d3570ad69\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"705a7b3a85e12e01\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"cbd9b5e83308e6c8\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"08e6108904d6df4f\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"887d42b45477276b\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"b01463b5e9ba8eca\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"6fdd6db8e29b728b\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"e223e4c9898cc9e0\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"91c1bd2e771c8964\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"02ef7e9716feae0d\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"d7db41a791deb8ec\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"ced71c3daf110817\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"7b85a2211f893735\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"f8f34428616c8210\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"97bef9dbcca866e0\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"33b36ea56b300244\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"06191e6b74ecace5\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8f299f1ff2bd082e\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"f79ea38d98216a92\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"9e5f12216eb153b6\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"c63208c40ece2032\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"17cb8957eb73cc10\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"696b7d50aa040cb1\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"f6d374509f1ef110\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"5af221e895f44dbd\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"309ceeb2938d437d\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2f5dbcc252e09bab\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a29412daaaf81103\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7075f0231e8b2edd\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0e949aa152ab875b\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"0f4b0f8073f74f8c\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"6356546d4c900e8b\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"fad00a02c49c6e5e\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"350c9855c2db0b03\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"60b8738dba36b47c\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"66cc86092ca41af1\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"377d5ae3fdf9bf5e\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"e9a407fbbc28c49c\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"282b8a5f7f5c405b\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"2239799079d64682\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"60195f0284603805\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"2fe070401f12055a\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"b828cab3202a8040\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"d177ca1c833a5f39\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"7e9d0618d932e3e1\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"b847f7b93854ea69\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"91def736b3e43c87\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"0402819b3190c7b9\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"280a20fd295ea410\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"a108d1ec2e894aa8\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"040dea6f0640c374\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"483bb1a669d2f761\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"28098663b538428d\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"4a970278c03e3c43\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"fff7c85160eb710b\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"c012eb0990a08a63\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"870e27fb67999a4b\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"b93288d663ee3f4c\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"7170bb588571ec1d\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"7b68baa5a3c5f1ee\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"422de5cf589079f0\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"d23912b879c13c62\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"8ad7e612ef8f0e88\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"d8d30c7e0f7774e1\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8dd96470f0f42a9c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"b66a9b7945f18a53\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7689ae8b8bc2020f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"53b44c148af10ed8\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"18295a4dc9b5ac2c\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"1c50ae4b8358f0f4\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"afa524298c42f069\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"a036499f047dda87\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"397f353a3d5d485d\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"9e8cf0f9d97351ad\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"5afce54f3a97c7ee\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"c7b45295afe52416\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"43ccebf7a524a5ab\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"abddd2ee9baaedb3\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"9f0e183fef1a5514\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"9755b0c1dccc2bd3\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"e69b0cbb836cbae5\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"137ce7a058b9fe58\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"a60a983d9bec254a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"0e850808fc3f00a8\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"881347856eed0c23\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"85de7c79b6ec2ffa\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3ba8c4482762524e\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"85e2a0f023daa0df\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"54cdb2602713e070\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"ed0153115f93db05\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"f4a0e649ddc82d72\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"f9cc78b8f0ed49ab\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"f41c84c554a8eea5\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"6c7f0197ec9edfdd\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"0d197e2cbe73e780\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"eebb745fb38595ee\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"73222d61bd5ecebe\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"b62128f2ae66f290\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"32fc396ca7b74d42\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"02d4556719103c5a\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ca9f1624bd8d9dda\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d81416ba51f0ebe5\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"5d56bdacb32d2fb0\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"1acfcb90a95bef7b\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"ca4891dbc585aafe\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"71e4b721ff386642\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"b4bd73e807589455\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"4155062d7e4f064f\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ffd050556d8b41f1\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"39894e44abc87faa\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"24341830561fa00b\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"c04a16e80a144fe2\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"9a070162f2b7bbe2\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"434888cb0becfe08\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"eff8af0f51743856\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"529f25eca136a5cf\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e478c623ada64356\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"76944a2f30e89f4a\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"bfd240ec1252e2ae\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"6424a037f1c69641\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"4d5f4cde690bcab8\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"c5b3cfe212809985\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"6eeb63c05cf29ff3\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"dc3a83b853df38bd\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"130fdd5fbac6f8cb\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"df8e57079ed8277a\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"35a1f4c1498eb6d0\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"bcc59de4ea1c069e\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"74319eafa135c68a\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"21d1ca9d773dc0d4\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"a8bafb703cda255f\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"403da7eab75d8888\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"d324855977b7433f\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"cc93164cd857ec7c\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"fe82a7ac5e382420\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"5da6f9a41d395359\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"6d52025f54994ace\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"72dd6fcb0441014f\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"352ba18ec0aeebb1\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"3629b2be27dd38c5\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"1377c1decf21a37e\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"22716a31f16e61e4\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"6d94b28196772f91\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"172c4b90d5dd3512\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"d14a74ee8a5210a7\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"9f484c261fa6552c\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"dc8fae5e2819f539\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"67d8b3b9e65b083a\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"dd2643eac40771f0\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"5d21434fd448f3b8\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"2f3e176ff5979345\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"37aa3f66ce6b9b1d\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"26dde6441ab8a7ca\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"3c64bca6315f4875\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"eb47504490f64a9e\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"882c5f3b89ae6e76\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"5a73d7df271f3ce8\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"30388b04edd38d75\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"181a750f2e9142d9\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"dbea7406be4b75b2\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"625f07221ab48470\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"c41cfe454683b41d\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"8dca16c9ca67beca\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"ba99d81a5eb29142\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"59e31450a8fd15d8\",\"/knowledge-medium/src/plugins/geo/index.js\":\"2b72d462ccfbac16\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"2e8640d36cd52895\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"691a282c628feb50\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"2896e9a2a32495fe\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"93d5e82641ca00a8\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"561028efea46d703\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"8a76a744daca926f\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"b2cb3fcf7d6e35af\",\"/knowledge-medium/src/plugins/geo/query.js\":\"c7c154834fa3c8a9\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"abf716c4c25fd387\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"238685c78a130787\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"119d3d02e3c3fa73\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3d2b3ed0bad48e43\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"e6472e2bc0e75d5a\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"c84de1cd3e7a0f99\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"fa9bf87e4e830b78\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"916a602d309f294b\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"a97c751196953f5c\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d8225ef6854cebd7\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"b4be9c4af1767cb8\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"8bc0fa7cb2b62135\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a81bdc4853c58a56\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"80462d4701503d09\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"359452103fae2747\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"dae5580f57692c6a\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"c2554aa47ef97c4d\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"40cd61e6c0dca9e8\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"9711c1780d50c30f\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"d003cacc394fdfe8\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"54d55ef6de5c81b0\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"a5730ee0dd8f2aff\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"92dd5359852c45e7\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"ccf2e9bba95eb8ba\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"9bdb37130d3f6275\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"7cb077c035e1d435\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"561643f7a1001e6d\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"0b77811b831c73d8\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"82ae27b5f18f748b\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"e4839cb872980d75\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"6c97f7d264f4844a\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"7259fda1e0b2f4e7\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"3d7fac4c0d719fbb\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d810184a31c22411\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8f73b08c429e8ee9\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"3adf20a54672a147\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"db5531b39272e5f8\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"8ecf7cda8d89ceb2\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"19a40c84e3543c18\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"45a839bcdb4e200b\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"949d11908c0f173c\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"ad86c2c19f96dc93\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"fb98fbc5837ba18e\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"a2cbfe5780a4dee5\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"80b0dda0ac2e7b4a\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"d05f5404e7c8d746\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"3bc9b401ab47c7b9\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"3cb28ddd5ca2bae4\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"d69a24f9432f4a94\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"d7e5f10f25ef7ba2\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"45d9f6ab1be6a834\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"d336bb3dcd9a04f6\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"831e545729baea6c\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"bf788742d69adc6b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"c58c7c886a6f1634\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a07ca14a3c926eb0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d524415b1e587a88\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"9978c0eacb858b28\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"e2b7e75303d4f3ed\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1451eb78da1fa2c1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"78fb00524bbe277e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e49d0722f3b3afbb\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"14db22f013cc6cb4\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"179914a12eef7e77\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"8ea1ee3cd5ca6cc2\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3f5c3d5d4fb93380\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"9131fb0fe1be7188\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"92fd3e6b28280674\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"b6b1d8d676f10beb\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"72425fd11b3ec561\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"ec425b62dc95c0a4\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"bbb6e2ce8ce7edf3\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"6456d746379f28de\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"2328184da8d23d37\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"330b23be0ef0c5a7\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"c9b11c30710ba9ff\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"8db5c2a49287897a\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"c92d1c3f9c52dc08\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"349a75598ccd8b5a\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"dca59e5cb7fcd0c5\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0a2f63b1f1fd99d3\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"7ab9a0c49fecc3bc\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"b137698e2c23f67e\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"f8ac94f9a23f74c8\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"8deb536e33c80f06\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"1537647e17c4e816\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"307a81c31ed2849b\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"f3d1ebec2aa2c700\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"490fc174958806f7\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"e85c7fd0be544c51\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"466dc844715e2497\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"96990944375b0846\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"ae12d88e64105d32\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"4100ce055c745bdc\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"73ce8b7ca2b180c9\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"5ddbb48b80e70748\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"b14fd1d8ce0710cf\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"ab4d199cf1dcac45\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"32b22add6368f596\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"62b1f8a35d6a589e\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"3967dbbb39089501\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"d4bc4fad8082c6d8\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"95afc067dc9717b3\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"e9a96a728a383220\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"d3ce40fd47018665\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"79bb06deffae4c50\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"1477ce1a438ab657\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"d3d2cba610699ce3\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"6070f96eadd7fd50\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"e7e50e5f60f6adc4\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"1bcddbfe00b82d7e\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"083a26ce35726a78\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"073cc215ecbaaed3\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"6600a3a97656409d\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"4589dfd5e7a32b4f\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"8c73557d24706424\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"383d6d7602c37a06\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"e2fc27cfc3961263\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"2596a590964da85a\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"3a52af10a5767986\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"556fe7b9707d24f9\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"3f0f99f814e2c07b\",\"/knowledge-medium/src/plugins/recents/index.js\":\"640854ed35758137\",\"/knowledge-medium/src/plugins/recents/target.js\":\"2d857ca86e2beae9\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"794f385978079f0c\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"34321051113d78a1\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"16228f33e48773d9\",\"/knowledge-medium/src/plugins/references/index.js\":\"49b8d8e0187795cb\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"351d4601b08901ba\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"8d574ce6a7c3eb91\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"edd8ec553701bab8\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"08e2db213e066389\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"09e58f3d6900f30e\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"231e74fe1f6db682\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"2f364d0dc3823d58\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b4553e53aed5f5e2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"959475b64fe759ef\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"f5a95d6ae58ffda9\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3834623bf0e59754\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"596190e96f8190f9\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"97a2650b99766df4\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"abb6bd2909949f98\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"958e9db2945aa120\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"c2e63bad2896b560\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"36f4ae48405791ef\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"69dfcbcdc3f0ea04\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"eb301eead9cadb70\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"bc485bb7ce634a92\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"1f53f9ce549dc808\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"4db71448716e998f\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"6b2192c87d3e20a4\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"1b0342136c2dbcbc\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"26e8022a661c3ac7\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"ba6eb139b64a2ee7\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"727815ecbd4a0df9\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"28a6ecf99e8e6533\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"a8aad6a531ee6ce8\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"ecee4ec692accbed\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"92b860ef950deb81\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"4d3790049886f5da\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"4439c7d76dda431c\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"fd20ada26d2f5146\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"64552a1f49325ae9\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"f73fe174f67a3e85\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"b174637bb1885b95\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"5495e8590230426a\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"a54e28ee3d55cbc5\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"95139fa3a37eb7cb\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"39ae3e1ce843e0d9\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"ac95910f1620ef49\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"43ff89c05b14694d\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"aa42b85176163e78\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"c23e87fb45db4424\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"0f9458fd8e343587\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"15a1fb20806f73e5\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"8b38786243c3d3a9\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"041e362fd2e4207e\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"70095b6900917570\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"507a849ca1ed64be\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"59f0d04783f3929e\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"5babe91dd105fc5b\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"d12b50ffac154605\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"38c5227103620342\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"adb5162546f2336d\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"d8429da42c593b91\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"7dfc864a00a64c35\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"172b761c2f66078d\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"53c851c609b097ab\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"64b3bda70629899a\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"ab7eb636eb8703d3\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"26be053a62a13a75\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"9391428e4788c508\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9771fdf0b14e6e87\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"1ff18c31a5a7eed4\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"2e45261defec196a\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2965fba5db1444cd\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"4ee50e020556db7a\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1358cd392013af81\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"541b3250dcae806c\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"52c40f48e8e38e1a\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"5d55b9b28d2d62e8\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8c11a9c54e7b4a5b\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"1cbb40695b868c28\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"f11bff400238094e\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"16e6291483b58ad0\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"0b080f620bb1988b\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"1dde9cc8d874bb1e\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"0d4cdc5e5211f639\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"b1d38299d145fe4a\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"df05c2f6baa5362a\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"836b41129448d1e0\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"ce772be63f7dc4e1\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"0f27cdacadd17ddd\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"2e4e6767cdaf956e\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"a5ee8e28b75bc52f\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"c173386a2190ac5e\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"9f65268ec0f33f4a\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"08bfb3ef1dff14ec\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"d4e5ae936145d5a7\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"413521ab0c0f1a13\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"5b1afe63684d3040\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"e660a7f699a06c62\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"592ec10e308024db\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"959b41dca4e06e0b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"573d88f282f51202\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"7eccd04829d30c8f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"e6777bad9c4814d4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"1154d6bcea3f0454\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"f663f419ba934984\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"e90d5f76df695df5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2b5f2419fbea1cbf\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"aafd29aa2a12a4b4\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"c676e5d768f16a56\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"ec5e43394169122c\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"12898c4db79a2601\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0bac9fd78d76ad91\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"aab78e2c35af67a3\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"7c0a2c0b74b4e29f\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"e3d340a30644a8bd\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"8e83609bf07757b9\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"119bc7a872c7c416\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"e26a118105da3dd5\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"bc3c6e07926665b3\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"85b9fcece06e91d2\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"6564670ce434bc5f\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"c23507935501e8fa\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"a350c2925b3052a5\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"575bdf7c115ba79e\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"e5290d7e64c8f69b\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"7d2ea2cf0a0db9eb\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"910b2d1e5cea5fbd\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"24f92e40288bd279\",\"/knowledge-medium/src/plugins/tables/index.js\":\"56183759b2a8791f\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"289c67d04ee5e9a3\",\"/knowledge-medium/src/plugins/tables/model.js\":\"cf8ec1692872d98e\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"085236e6a6f77bcf\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"44498c18cc96e475\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"3e9b893c13e8824e\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"6214a279c8a5df00\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"356bea9766f73ae8\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"04be48e8dcbc5c78\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"5cf74d033fc9af0e\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"9578adf7e83bfdc1\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"5362f580274ea798\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"4fdbc50e6e70426e\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"6d9ea638fb7fdbe9\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"8f4be19d05eb811e\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"a0e1782ada99c415\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"a8c6467e30010ed5\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"de8be19cb485f9be\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"26517abf4a47ce38\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"740295360838b9c4\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"d815278b2c6adf27\",\"/knowledge-medium/src/plugins/todo/index.js\":\"c69f25bc4b47d3db\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"b9daac3c01ce039d\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ce3a687334f2198b\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"8b5c5dae0d639c90\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"bea9117b8992de27\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"ab72ba4596a52fb8\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"b3b1fbe51e404806\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"fc404493ce14c990\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"d5f12ab3ac9303a8\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"46aa5aa8a4ff77e4\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"5ff4c95eb7cc6a56\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"d3930ba55aa92ac6\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"096fda6a11cab607\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"2c7229bd4b0e4fb8\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"144048d497f747ad\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"6436768a7d2f9213\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"83cc087ae29fe1ae\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"d7a3fd90aeaa58eb\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"2b03abb7354f7146\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"5ce8003d608d7e6e\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"7fc5f2d4786d3ca8\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"edc994b1c2b276c1\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"20b68406cb03432e\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"6268f7dc3929e881\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"99c017d01f92019a\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"51b89850643c524d\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"3b61cac6a2fed7a4\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"50b88aea3ab33f83\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"6920eb273885cb86\",\"/knowledge-medium/src/registerServiceWorker.js\":\"34246ea2a2360975\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"dd1ce9bd6c0e8b40\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"a2e5e86942fb9029\",\"/knowledge-medium/src/services/authStorage.js\":\"92543de0970c7879\",\"/knowledge-medium/src/services/powersync.js\":\"7da7c876e80782b2\",\"/knowledge-medium/src/services/supabase.js\":\"5a8f33ecaac8a2c7\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"0c4d580035e367e8\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"bb9a5051af06f360\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"6450515bac96df38\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"04aeda879928869f\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"802cbbad939fc5da\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"5a819736240c1f44\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"72b52eeebcea7da9\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"dec48085704f006a\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"a82de662c13f6f55\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"db2be2bd9a94543e\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"d292f3f2721c5431\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"0bb26ffc1410650d\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"a051fce76ed3bf33\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"a508061f4ed4ecf7\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"7e82c8ec8865eaeb\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"7c0ddea416aff562\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"67d4b7d2e6baf573\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"3506ec57e79e0861\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"c85e0cf563aa35ab\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"2ae24129d140e470\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"7c9dcc8d9a3fdc3f\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"aef4a550d641773d\",\"/knowledge-medium/src/shortcuts/types.js\":\"7c71967c68c8d22e\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"d8a458fe794953f7\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"6727fda068576659\",\"/knowledge-medium/src/shortcuts/utils.js\":\"9f245e1aaa012c07\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"2aefa42c33b1b4da\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"8e774db3ed13f928\",\"/knowledge-medium/src/sync/byteTransform.js\":\"12d8373e42637bc1\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"4a9bce27bfc0ab43\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"cf02bef3227ecf54\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"840f65a60aad82ac\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"0646952de7121f6d\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"1c4b1e5e86b20496\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"d9f41e2dcd0f2737\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"1e7f46c96d49d941\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"58618d236779e6b0\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"5164ece6edf03b22\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"3e45b318709cf0a8\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"b2567e1b04bb0ca4\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"563731dd8f7176ff\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"c51f5ecdc37ef22f\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"eca03faf04190871\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"127cae6b70b338e1\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"66bbdfc352a5781f\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"5684dbf8f6d03862\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"d788932adce62dbd\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"5da99fc734a7ced2\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"fae88cf4daba2575\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"f87d9f11d3918364\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"40250ac3cfef9d61\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"b9c24e5cc4907f8d\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"ab0b4b4e4763aa2b\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"8b2f0d56f8cb2c61\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"7da6061c002f4a24\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"eb39b2ca92c9870c\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"9e648a35f1350d24\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"9fb63bb51919266a\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"6ce1ee3e11efdab6\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"cd64fd41a29d2be7\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"1494bfa97dd3ee61\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"941d6350709429b4\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"9599381bd6f6b4ba\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"417807520fba10cf\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"104f16f7de2a8b1d\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"28ee966a8782abfb\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"f7b21448fa5fa7a8\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9058fe1ec3b41f33\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"1de50c0171fd3792\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"2eb05802c62a5611\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"74c7def3e467a8ff\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"04bf0ded41a03d08\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"c62a0cc02949977e\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"c9a21d0a4b45e23d\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"2ba245855e49967d\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"654c8fdf163f6490\",\"/knowledge-medium/src/sync/transform.js\":\"ea9a146ee8574397\",\"/knowledge-medium/src/themeBootDefaults.js\":\"d7093698c1158794\",\"/knowledge-medium/src/types.js\":\"591dbfd105267023\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"49f6f66e828599e6\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"64fef820870f6dfa\",\"/knowledge-medium/src/utils/array.js\":\"126162e4281aaaea\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"961ae99f8b5055d9\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"c996cec9a4720ca2\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"792391febe2f3894\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"1a3443ef55d733c2\",\"/knowledge-medium/src/utils/callbackSet.js\":\"0a41dcf6f92132b3\",\"/knowledge-medium/src/utils/clientId.js\":\"c6400116b3a951ca\",\"/knowledge-medium/src/utils/codemirror.js\":\"3f13a52c8a4c3208\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"7a82cdafba25065c\",\"/knowledge-medium/src/utils/copy.js\":\"48abd8c9e9a7e551\",\"/knowledge-medium/src/utils/dailyPage.js\":\"1ed760b6b9fc0202\",\"/knowledge-medium/src/utils/dbForensics.js\":\"611605e478e508d4\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"f95ac91fcc3a7aa7\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"1a86d94484c58356\",\"/knowledge-medium/src/utils/dialogs.js\":\"73a826532c1d6201\",\"/knowledge-medium/src/utils/dom.js\":\"869fa6aff2e088af\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"b1bf9bef6d5dfed8\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"a434a5e3859ed5b9\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"29069863952b5e2c\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"561e38d50a1faddc\",\"/knowledge-medium/src/utils/flipSlide.js\":\"9dc2b6f54725bce9\",\"/knowledge-medium/src/utils/fnv1a.js\":\"3087eb8d2a784d29\",\"/knowledge-medium/src/utils/formatBytes.js\":\"6745923c86f5eff2\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"eee89f39120fbd5a\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"04119101b738efad\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"5792e2eabc4aa05c\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"2197912805061389\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"428d5bcf4ea19815\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"077b572ef1553e59\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"a71ea1aecb9fc431\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"02c0556ba91b661b\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"208da10ef8a60153\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"aa27514ae2ced555\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"3da9c22ba80cfb45\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"33420e7e2fc1fa23\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"4905e77ba68e250d\",\"/knowledge-medium/src/utils/markdownParser.js\":\"48e392dfb6792360\",\"/knowledge-medium/src/utils/memoize.js\":\"ebdaddc538f7cdd8\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"3bbb694de5e52b21\",\"/knowledge-medium/src/utils/nameList.js\":\"e5dfb267971af3d4\",\"/knowledge-medium/src/utils/navigation.js\":\"a1a12a27fb08349e\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"cfccd4005da707dd\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"a107a95f633641ce\",\"/knowledge-medium/src/utils/panelClearance.js\":\"b12cf1afc393246e\",\"/knowledge-medium/src/utils/panelHistory.js\":\"9fd31a6da2f907a9\",\"/knowledge-medium/src/utils/panelLanes.js\":\"d9b811db2232af02\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"cb72c769fde11317\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"862c80d38f302018\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"5af908502ed7c503\",\"/knowledge-medium/src/utils/platform.js\":\"677583e367ae1c93\",\"/knowledge-medium/src/utils/pluralize.js\":\"b0c639fba4fd16b6\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"570e92cf8eb55424\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"769ea44b2ce39024\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"bac60974f7c57e0b\",\"/knowledge-medium/src/utils/react.js\":\"31c153d3b114a7ad\",\"/knowledge-medium/src/utils/relativeDate.js\":\"399673a5e48a6cfc\",\"/knowledge-medium/src/utils/relativeTime.js\":\"d6e6d3129f59263c\",\"/knowledge-medium/src/utils/renderScope.js\":\"80128d6f09cc1805\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"59222467c96202e1\",\"/knowledge-medium/src/utils/routing.js\":\"5efceb1eaebc3fed\",\"/knowledge-medium/src/utils/safeMode.js\":\"089eacc235fcfc7f\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"420b4cd2273d7d98\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"b51e5b4afec1503d\",\"/knowledge-medium/src/utils/selection.js\":\"686742bd39458028\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"b9e19ff5d793b23c\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"ff0d84013e432cb8\",\"/knowledge-medium/src/utils/state.js\":\"47a70c0765629432\",\"/knowledge-medium/src/utils/string.js\":\"f45bd808bc5d1d20\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"c533233820cbf5a3\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"ad3ff3b9179c1d1f\",\"/knowledge-medium/src/utils/toast.js\":\"fe731177f0c311ef\",\"/knowledge-medium/src/utils/toggleStore.js\":\"d3e21dd55123baa8\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"cfa6b2f96b592789\",\"/knowledge-medium/src/utils/userActivity.js\":\"d7b6669fd11509af\",\"/knowledge-medium/src/utils/viewTransition.js\":\"bd01d99dd4398ffe\",\"/knowledge-medium/src/utils/viewport.js\":\"79c4717cac92fd30\",\"/knowledge-medium/src/utils/webLock.js\":\"300e280b92578c99\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"240d3f0769e749fb\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"5474e79ab18e0449\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"dee7fff3ba12483f\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"d22a0536cb901cdd\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"5ba5e3e23b70abe3\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"e2aefe23e0c45f4f\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"2dbed4d01403e819\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"58df94a70317a4c4\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"2281332f560f8fb6\",\"/knowledge-medium/src/vendor/react-dom.js\":\"71dd48545f9ad193\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"4ac4a82544327673\",\"/knowledge-medium/src/vendor/react.js\":\"f386777bb5e65289\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
