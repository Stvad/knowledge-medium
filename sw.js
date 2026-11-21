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
		buildId: "fd7abbb9a51b-7862ff1d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"17474bcabd28a1bd\",\"/knowledge-medium/index.html\":\"17474bcabd28a1bd\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BUKO58DY.js\":\"727dbecbfddefe0d\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"3b644f858328b22a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CsDOVS0O.js\":\"1b15f6f5ca87d106\",\"/knowledge-medium/chunks/FacadeVFS-BQUR0c_R.js\":\"0ae3f78106ca1da5\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-CwJzkXf5.js\":\"b8d1899ef342be39\",\"/knowledge-medium/chunks/MemoryVFS-DMdCb6dL.js\":\"4da89655ec074242\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BQWbqkdx.js\":\"62053b9a0e3e22fc\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-De0mpMdC.js\":\"a8763bcd386b620a\",\"/knowledge-medium/chunks/Preview-CE0XTeZ2.js\":\"37a4b79b37253e05\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CWz_BjeL.js\":\"3bf7807c4d470dcd\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CN6mVJiG.js\":\"fad984db54d2923b\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-4v9M8911.js\":\"7067b6f3b74b5011\",\"/knowledge-medium/chunks/react-Baw149OJ.js\":\"111bcf7518efae8e\",\"/knowledge-medium/chunks/react-CLIWW8cX.js\":\"248c1ea21e63a6e8\",\"/knowledge-medium/chunks/react-Cl2A8zx0.js\":\"b6cb56d53d7c2e40\",\"/knowledge-medium/chunks/react-D3ZWI6AW.js\":\"cc34458d1cbee859\",\"/knowledge-medium/chunks/react-DabsQPH6.js\":\"1ec9507726026450\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DFtPdycF.js\":\"d3ee41f92d5ce6d8\",\"/knowledge-medium/chunks/react-dom-server.browser.production-BgrG9mK6.js\":\"3be9a9da8074ae2b\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CauaPS0V.js\":\"deb443310c8dde18\",\"/knowledge-medium/chunks/react-puebm8dI.js\":\"d8d1380ee744c07c\",\"/knowledge-medium/chunks/react-qhhxqieG.js\":\"bd0466d5d32aa6a3\",\"/knowledge-medium/chunks/server.browser-BdCj8vCq.js\":\"f5e577a9b1308b19\",\"/knowledge-medium/chunks/textarea-Bw50inci.js\":\"5781201fa2cba661\",\"/knowledge-medium/chunks/ui-CDCt1Wch.js\":\"698269cd4f6b3f69\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"342fc0d0456d72fd\",\"/knowledge-medium/src/appUpdate.js\":\"0b7f541a7d049d03\",\"/knowledge-medium/src/appVersion.js\":\"3f7199acb04d1958\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"b3336bd24a26c016\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"3dacf5f4b3bf6d48\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"61a597fe25ca53c3\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"03faaf6dcbcc97ea\",\"/knowledge-medium/src/components/BlockComponent.js\":\"9e4c178de416c3f5\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"985bf6f2cb32f423\",\"/knowledge-medium/src/components/BlockEditor.js\":\"4670674200d9fecb\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"4ebc168d0e7659dd\",\"/knowledge-medium/src/components/BlockProperties.js\":\"8011d5680b8a8197\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"bddff8f86837963c\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"44b4d67d520b9ae1\",\"/knowledge-medium/src/components/DividerHandle.js\":\"694f19ec4292c4bb\",\"/knowledge-medium/src/components/DraftEditor.js\":\"5feb17232567edae\",\"/knowledge-medium/src/components/GutterPill.js\":\"c74d6c234913b13d\",\"/knowledge-medium/src/components/Header.js\":\"4266f4fba358f5cc\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"1085b2d8e5b5d82b\",\"/knowledge-medium/src/components/Login.js\":\"b3e1f8724e15d05a\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"5e0d053e9f0e3fc1\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"1d9b56b92fef4653\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"695b6bc31583e051\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6cd1a426e5708598\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"b9e6e2050dffe7e6\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"4bd40c6b5b19f533\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"5eeaed9b5572c66f\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"e610733da7964181\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"8d8b4366be3f8656\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"76aef79cc217cecf\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"41e2892599d3a8ce\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"c48b0de37e3b791a\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"cccb95ad9d18310a\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"3407ee60bc301e21\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"3ad37cc886c730a1\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"5aaa502ae277baf8\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"b68c1e7800584b47\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"3fc0c40318b56846\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"a7194ec36ad6f54d\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"cfed15901b112476\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"e815d6bf2b90b7e4\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"19ff39f80d28f2b2\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e315ba8af97fe9cf\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"d4448788ce77ecdc\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"4ad73925c7a066de\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"1b9a0e3f74391099\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"710bc3de68ddd54a\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"94834e18a35b90d0\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"8e867c3d90db3faf\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"8ab7ccfa54f0dee7\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"ae59450fbb45ed30\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"e19a18e711c4ad44\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"d4125cfd7b65b37d\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"24c96229e511f11c\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"f8839987a67e8dfa\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"079e2eda214c570a\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"cfd3a7f353bf1d9d\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"e41e233926c5f90a\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"f09f3572c6bdc98b\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6efa849ca0739da5\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"d3828ae79a013cba\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"400f7d971bbf34c4\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"89690184e01bb5ac\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"6b4a6e2368c2bbe3\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"0ef6a26741f02b79\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"178847d14e669b78\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"765752f8813222ee\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"16a9d9f261f229e9\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"f0ee92925744a29e\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"98f4d71d93c172c0\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"89f70371b033537e\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"6dfb7c4f6aafefb1\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"694a22e791adbff5\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"a77a7bf1111282b0\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"e74bd532b253f261\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"7d93da0c22340eb1\",\"/knowledge-medium/src/components/ui/button.js\":\"990e70a633a8b39c\",\"/knowledge-medium/src/components/ui/card.js\":\"c5de76bb4b5a5156\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"307115996bb45736\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"6b5870e3887e8076\",\"/knowledge-medium/src/components/ui/command.js\":\"df43443da0ecc501\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"82548c0f514ce156\",\"/knowledge-medium/src/components/ui/dialog.js\":\"2a93fe645e1ec78d\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"8066ca9c3eb79619\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"cd652ad32811741c\",\"/knowledge-medium/src/components/ui/index.js\":\"8c87c909d9696c61\",\"/knowledge-medium/src/components/ui/input.js\":\"fa3d905737d2c410\",\"/knowledge-medium/src/components/ui/kbd.js\":\"4b1e477832d4c577\",\"/knowledge-medium/src/components/ui/label.js\":\"f042331f92344cfe\",\"/knowledge-medium/src/components/ui/textarea.js\":\"dd84864b3291c653\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"a2253b79b8fdaaac\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"93db8daca6419836\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"579a8901720bfd2a\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"8800082f061ecf0c\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"ee184ab24a5b52d1\",\"/knowledge-medium/src/components/util/error.js\":\"5f21ead5d085626c\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"629d281b12d338ca\",\"/knowledge-medium/src/components/util/suspense.js\":\"5ed8275c579d0080\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"f19fb1e682137ec4\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"fe623e4787e47711\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"db9d30a185668e2a\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"38f185a90aa974a1\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"fb87eda7bf3fe263\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"95d2b10d7981facd\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"68206cae8bbc897d\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"91ec61e2452c2536\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"feaf7dcb8a4ce762\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"0b47d8b9efb514ab\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"00a7c53b6f43faa1\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"cc114a3e482eb68c\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8946ab44223ba960\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"252cc536668777e4\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"57b6a7a92e507269\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"5fa464c1d591d3f9\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"68844487bf202a45\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"76dc81c836c0693a\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"63ade985e0df7e93\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"7b39b1a606ee9857\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"e9e873f81bb7ba5b\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"8fe3a200957b03f3\",\"/knowledge-medium/src/context/block.js\":\"55c59162ba6e13df\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"4c1ed1b72b39ac1e\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"0a124d87fc1ef3b6\",\"/knowledge-medium/src/context/repo.js\":\"5103bd64c7927b25\",\"/knowledge-medium/src/data/aliasClaim.js\":\"e1ec4fb27d91d9b1\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"009a369ffdb3cddf\",\"/knowledge-medium/src/data/api/blockData.js\":\"bce203a48a78ee86\",\"/knowledge-medium/src/data/api/blockType.js\":\"b20be3f3de72fe95\",\"/knowledge-medium/src/data/api/changeScope.js\":\"dcb920f1f3f5e5dd\",\"/knowledge-medium/src/data/api/codecs.js\":\"6ba7b36ae91a6df6\",\"/knowledge-medium/src/data/api/derivedData.js\":\"ca9c45e45aeb490e\",\"/knowledge-medium/src/data/api/errors.js\":\"2e6a33d45f714383\",\"/knowledge-medium/src/data/api/events.js\":\"25ba4a56a046d989\",\"/knowledge-medium/src/data/api/handle.js\":\"b02b4b19ab6fc1ca\",\"/knowledge-medium/src/data/api/index.js\":\"0f6e72101b1a9762\",\"/knowledge-medium/src/data/api/mutator.js\":\"0444e90247e641d1\",\"/knowledge-medium/src/data/api/processor.js\":\"7b962bdbf19eda5a\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"e8f43383a302e4b9\",\"/knowledge-medium/src/data/api/query.js\":\"f1ba5ff9274965c3\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"72889b9cc1e26c03\",\"/knowledge-medium/src/data/api/schema.js\":\"b02b4b19ab6fc1ca\",\"/knowledge-medium/src/data/api/tx.js\":\"b02b4b19ab6fc1ca\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"bd926e6979160e8b\",\"/knowledge-medium/src/data/api/user.js\":\"0360ef4e62fe419b\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"9acce0be38a0aa49\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"e2dfd22e7035cf02\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"0197f7ba08eb4356\",\"/knowledge-medium/src/data/block.js\":\"4329354b44281e52\",\"/knowledge-medium/src/data/blockCache.js\":\"03957a204e123072\",\"/knowledge-medium/src/data/blockId.js\":\"2de1d4354cc826ad\",\"/knowledge-medium/src/data/blockLiveness.js\":\"cf085197d1dcea33\",\"/knowledge-medium/src/data/blockMerge.js\":\"1d9505416731bdc6\",\"/knowledge-medium/src/data/blockSchema.js\":\"f1309032c97c33c8\",\"/knowledge-medium/src/data/blockTypes.js\":\"1e1aba6be58da3bb\",\"/knowledge-medium/src/data/clientContext.js\":\"8953072f0b4265a8\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"e26d26f42eb7b4e0\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"1f6c21662727a229\",\"/knowledge-medium/src/data/derivedIds.js\":\"301dbcc3d771a26c\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"0be599a825c5c35d\",\"/knowledge-medium/src/data/facetBridge.js\":\"4f83f394d50eb0d7\",\"/knowledge-medium/src/data/facets.js\":\"fb74dec4dd451b29\",\"/knowledge-medium/src/data/globalState.js\":\"2437e810aa726f85\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"50a6c26af5e34445\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"24742f2644b35fa7\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"20d3d80d83f1227b\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"65dc9ba239708cc5\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"7e5e43b5546b8345\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"2fc19a94199dd8db\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"fbbac5fd9a2bcc93\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"e72cac45cfe5caf1\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"adfbfc464181bf37\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"a2eb100b8e80353a\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"627bd0afa70ac87d\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"7a64e7773ae70acf\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"4905cc779f5a441d\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"89ac2780e6dbb9cf\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"162e4d8e316284d4\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"fb8d9967ef224038\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"00d75d116c159daa\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"35d216dda055e73e\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"d50e5f11bd0e6a38\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"dc54666266a6f81e\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"10acf79c2bd7db2a\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"6615537d7851e979\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"6ab2cfd3809a0eb5\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"15a6a90719ecfe10\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b76a3472b338e594\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"c63f766611f26dd7\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"1163f631698e316e\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"9d4c930cac28e751\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"33dcd6c56d67f31c\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"5b66d18ee4e70966\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"50704b896366dc18\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"4feea99dd9fecacd\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"dd84ad16b5a7349c\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"2287098cdff9c73d\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"12cce2265c11fc98\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"139dc2c8c4799676\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"9bce11ee6a256aa6\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"e360ff72455f314a\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"e3648ce6bfcca684\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"56fd5843d0f2f816\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"75bf266af1a2e958\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"13333bf5b1f532b7\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"d169b47c267047b2\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"728b4ce8bfdfbd70\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"e5621b2823897654\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"4cc503b455be2ba9\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"a2d51f2cf131d595\",\"/knowledge-medium/src/data/invalidation.js\":\"3496558e5453caa8\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"8603aa684489196a\",\"/knowledge-medium/src/data/kernelPage.js\":\"d85810d0256aff3d\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"8b1402d36cbe94ca\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"355fe04d9ef782dc\",\"/knowledge-medium/src/data/localDbStorage.js\":\"eb2e4e9fbc347f23\",\"/knowledge-medium/src/data/localDbVfs.js\":\"7db340e0aa3fe70f\",\"/knowledge-medium/src/data/localSchema.js\":\"4835294747348737\",\"/knowledge-medium/src/data/maintenance.js\":\"afee8dac18133f9a\",\"/knowledge-medium/src/data/mergeProperties.js\":\"2caa754d8c55f0a9\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"9aca2093b957fd9f\",\"/knowledge-medium/src/data/migrationsPage.js\":\"3af86affd8c86abd\",\"/knowledge-medium/src/data/mutators.js\":\"9df62b1d6dd6d261\",\"/knowledge-medium/src/data/orderKey.js\":\"d86bf72055a54c4b\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"8b89222d38e30bbe\",\"/knowledge-medium/src/data/outlineSurface.js\":\"74211746ad38a312\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"27d0e171ec0dc57c\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"9653dac419be4833\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"bc2ddf5877ae7729\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"ec413897d8be4232\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"2ecfcf38f44e18a3\",\"/knowledge-medium/src/data/properties.js\":\"79d386b3d38ee322\",\"/knowledge-medium/src/data/propertiesPage.js\":\"7b5a53a71baad69c\",\"/knowledge-medium/src/data/propertyChildren.js\":\"32bf79655c84f0e7\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"b610129c79184453\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"dfbb93df9343b677\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"309cf4b5d8914bb8\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"de3e00aadd6fb1ec\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"4097fdbfdb1e4647\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"a2ef202f41a994f9\",\"/knowledge-medium/src/data/propertySeeds.js\":\"d4e309c6f856701a\",\"/knowledge-medium/src/data/recentsPage.js\":\"1e3b9b2e92cd6e16\",\"/knowledge-medium/src/data/referenceBlock.js\":\"bdc058ad29c688f3\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"01cf72d70c181c50\",\"/knowledge-medium/src/data/repo.js\":\"f93eeef51efe389a\",\"/knowledge-medium/src/data/repoProvider.js\":\"4eb004c22769d151\",\"/knowledge-medium/src/data/rowProperty.js\":\"d8be9366dc45cd58\",\"/knowledge-medium/src/data/searchFilter.js\":\"94726e3ec0f2683c\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"310b2c42d6a5fae7\",\"/knowledge-medium/src/data/stateBlocks.js\":\"12f3dee8c7bbc911\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"dbd284e2425bd330\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"9799bbdb27821c97\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"ff61812e3be72642\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"4fc58d79ae0fb2fa\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"7fc28dcadca665d6\",\"/knowledge-medium/src/data/targets.js\":\"00aec2cda3b1da2a\",\"/knowledge-medium/src/data/typeColors.js\":\"11a8fe3e282fdc01\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"a9a2b4203a335b25\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"7db11f7b1b7945fc\",\"/knowledge-medium/src/data/typeExtraction.js\":\"3c9f5613b727ff8b\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"e2bc90c21b75a151\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"b262576afb4cac50\",\"/knowledge-medium/src/data/typeSeeds.js\":\"e46368ac5a190019\",\"/knowledge-medium/src/data/typeTagger.js\":\"8a77971630aca650\",\"/knowledge-medium/src/data/typedRecords.js\":\"a04418da5e046349\",\"/knowledge-medium/src/data/typesPage.js\":\"7ed6810f9de5e68d\",\"/knowledge-medium/src/data/userPrefs.js\":\"b1f402b6d9aa8ed8\",\"/knowledge-medium/src/data/userSchemasService.js\":\"c003cdecddbb1b00\",\"/knowledge-medium/src/data/userTypesService.js\":\"f610d567e8142cd7\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"e8a9f2a7b9804c4d\",\"/knowledge-medium/src/data/visibleChildren.js\":\"b70046f544aaa3ca\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"76c552b4fdc0cd79\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"876f1c3aa3f1c36b\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"123c128f6a3092c4\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"a5aa8e6180135364\",\"/knowledge-medium/src/data/workspaces.js\":\"c1d833b102be6e5b\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"a49e3a0e76b38a6d\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"814081d7161c5260\",\"/knowledge-medium/src/editor/atTrigger.js\":\"3b9c02b7d835a71d\",\"/knowledge-medium/src/editor/autocomplete.js\":\"b9fe1b0ce8348e6e\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"2b408aa7a515c29b\",\"/knowledge-medium/src/editor/contentFlush.js\":\"0fca9ea14232f4ec\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"59fa38e78fe30b1b\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"a63fb2894d5f0b10\",\"/knowledge-medium/src/editor/insertImage.js\":\"3cb55029d7e6d6a9\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"10d79e065ec1f143\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"687ac03e5e7519b7\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"aff555aa55f68286\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"c04dfa99e4bf07ba\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"8052f487a51d47ff\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"8f4be46a2139ee08\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"77d01cead7d3d20b\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"896c89365362fb30\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"1ceac1078a0d3426\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"ee502488418d4daf\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"d809265cbff87215\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"40651de8c9dfe7e5\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"7ad322d4a7643304\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"13cc7f3734f757e3\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"43425e2908a3d54b\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"99477a454da2b524\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"266ed65ebfc6b191\",\"/knowledge-medium/src/extensions/core.js\":\"ac4cc150fdb1c028\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"2e8b9c96b307d593\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"d888678986c4722d\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"2efcc88181b65951\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"dfc3852006cc1e71\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"6e3d6046dcc60bc2\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"e59fdceae3d75e1c\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"9c84e44299010a7f\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"664141604563d021\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"66b62693e971d855\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"47b385d3e48dd0b2\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"3f920044de7780be\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"ed4391b61438fd7a\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"71a95917f9fe6c59\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"a88e8f92c299d2e1\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"1a1de9b527b94d85\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"982c8c47e80abca1\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"f55acce5fe4e62ff\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"9db8b3fa3a1b229a\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"9007d470efa6a02b\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"7f29ec9669f15585\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"428cc02123a78c98\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"66dab814e3d4769a\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"02bda992c84580e6\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"a01df51c84f3d12a\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"5151fb2040211489\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"cfd63d4bbb491bed\",\"/knowledge-medium/src/facets/facet.js\":\"708c38553ac75c4d\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"e8bc2baf91724814\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"3ce9526f4701ac0a\",\"/knowledge-medium/src/facets/togglable.js\":\"7c1d35e124e8d89c\",\"/knowledge-medium/src/facets/variantFacet.js\":\"47f9084b202d46f9\",\"/knowledge-medium/src/facets/verbFacet.js\":\"449321fc225d11c4\",\"/knowledge-medium/src/hooks/block.js\":\"9c259b66671642b7\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"2f93015ee390c87d\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"e4c4b98e0bbdebb5\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"8d7c41a3c732450c\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"cbf27c615ac4174e\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"67c9d329e067539e\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"67754717a5627027\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"d9d24247f6ae9c86\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"5b52be63e06b6343\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"6e387e8c7aa8c6e3\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"0f8033b7aa356633\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"e0b68a516b81f2a3\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"827bcdcc96dfc5f0\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"cabc71e221a74ffe\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"618e7c6970144452\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"5f716cf44b02703b\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"58ab0a9209350123\",\"/knowledge-medium/src/lib/utils.js\":\"6efa20732797e434\",\"/knowledge-medium/src/main.js\":\"5cf9d328a7f437c0\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"c243f3a3db936810\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"9bb5df7c08374ae3\",\"/knowledge-medium/src/markdown/context.js\":\"fa34fe3172148bf1\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"21fefbc2ff238592\",\"/knowledge-medium/src/markdown/extensions.js\":\"1cbd1320e8951c94\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"9cfeb239abcce1c9\",\"/knowledge-medium/src/minimal-editor.js\":\"3679108de78392ed\",\"/knowledge-medium/src/paste/armedCut.js\":\"175ddf5c035452eb\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"9f18e193115a0f80\",\"/knowledge-medium/src/paste/clipboard.js\":\"8d6ea3b8a3829db6\",\"/knowledge-medium/src/paste/decision.js\":\"7dc1f63032ec5abb\",\"/knowledge-medium/src/paste/operations.js\":\"db642e9cecfc6e5e\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"3640b1e19eb8e8f6\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"143b16c2b32825c3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"82c8dc2a206fcf71\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"b94bfc8d7f139b83\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"6170d34ca5acb98e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"bb72fa350f3c247c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"f1e747c1df7219f7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"9f7e3396cc849fa1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"25ac698355672d36\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6d7ebad36939f542\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"04ba7192d2b12643\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9176c5f9bb87706f\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"3cf156cdaa4ae59c\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"28eb3d38c222aa20\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e2d8b0e879aa1eb4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"372440ea23665f95\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"4ecfe1cb7f56b6e0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"3a33e662bd2f88a4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"e7aa77b8a11b8c4d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"ed590821346bc777\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"bf7546cfd92804e2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"30f26003063a4bfe\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"cc30c392eec3a562\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"7f49fd7ead87633e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"d4ffb8865044f307\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"fc46274b6db664f4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"fcae58fb6119d581\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"d8ed847e03ead081\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"47fb9585d811ccee\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"e9c10a3221e968bd\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"e37ce8fd38689ab9\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"8ecb56c0d1924f94\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"8b1cde44771c8698\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"3f96be32531e85c9\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"3949bf405eedd1fd\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"d277ccd5dcf9568a\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"4558c57b2853424a\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"2cb6d64c9d1c1409\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"c359c0b01ce2052b\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"3d0725a7eeca7e94\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"89e7fbc8fdc06b59\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"c4e978ff665e94d9\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"c57ded088b89c163\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"46f30a7aeb32182d\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"03e148a0e71be13b\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"2c5a469b60bdc6f1\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"5482f26094902900\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"c09e092bdee04a5a\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"8a7f0efaedfb285c\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"afbb71476cd40a0c\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"94a6335ece2647a9\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"3978d05e0ce9b4a7\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"ecbefd7b5dc2847c\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"5dd3213310ce0612\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"acb3a0622e3f5fbc\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"56c6446490e9d7f5\",\"/knowledge-medium/src/plugins/alias/index.js\":\"1568319943966eea\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"4342d8740747bfb0\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"2460259c77b0f593\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"290bec779527fd5b\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"cf316f083d0c249f\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"ebd3715e4ce23374\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"a4ee1cf6c35bd454\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"dc84c29875c5821f\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"9884d1f799f16777\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"149093c61c06869f\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"b2427b17b06071ab\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"23acedcd5027ab1e\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"0665121932cab43a\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"63d76799d3893389\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"b22d6aaefe5221cc\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"71cf6096651f5bd4\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"188d63afe5041c0a\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"967d8d9299965443\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"21d43592d17fa904\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"890757b27be8413d\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"aee9d70982cb8290\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"afea00127e2b9b40\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"d52a1562033289aa\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"ee7384a4be23ba80\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"08aa37b112f3209e\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"dd528ff714ca857d\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"d3c3e8f90bea8a75\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"46ded009219787a8\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"37a145da84f20a2e\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"a50ad9be648aa974\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"d29f8308bc9339d2\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"5dc1faeb803cbf5d\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"467ed802601e3a7a\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"aeb66a7ffafe2f57\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"b7cb1f6b7a1dc4ad\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"7b6c1c5641835b33\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"777eafe8a75b8d78\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"b42051e6117db47e\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"5c6b51f24f4bb3a7\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"371e2d7719e5c3e5\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"0ff0270baf3abf54\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"02721322933378c5\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"090b7144a4449c6a\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"061b686ad6e27641\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"36c32e6d32e56853\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"cc0d86f3f6ed7ef3\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"572e376fe7dc2e91\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"90067646682d52e9\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e483f15dc34dda67\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"e97122b6c1afe510\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e4feda9b5c0a6557\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"4ba6a11521fb4e90\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"91f9685334c496f0\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"ea3af083e6c632e5\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"6ead8401a6acff53\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"2fab3ca00512640a\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2e909a8199960e59\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"99492365edeed8b0\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"518a9c71f6c7f62c\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"03a8448f4a21d266\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"7ac0403fe6b8ee0a\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"0ca8f6639a86a8c2\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"8e4209adbc740189\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"d08a5684d4e90062\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"866fd0b482888723\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"d6010a183be8157d\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"d45b927e87d42c68\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"96a121f9fc113b67\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"72fdbcde53914d58\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"37c04b05a4c7f8ec\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"2c9fb9938155d254\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"a22f35256b866bdb\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"eecd47baf5ef46dc\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"b56179deb94a56de\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"f8a5830d10192663\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"06b6389bfe854b34\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"f944a53d640ef0ee\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"dd3f25338b245d68\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"9a6a564d95be362f\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"e7c675e8055e495d\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"fb5ea08a51d7f893\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0b0c433f5615d3f0\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c00c7208610ed468\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"03cc0acd53db8074\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"59fb78636260a8c2\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"00c8736dadb7a542\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"348329ec3b558a37\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"abb19c79b2fa4622\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"59fe2375b3b8ee5e\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"ed3ecb388e9b6143\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"20e8991390f05b7d\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"963733c28c5890d8\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"196dc071ba47b76c\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"c9a33892045cd7fd\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"e17890047d7f5cb5\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"dd5a383027acdd71\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b3d7e1666d1e3c2c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"f98b76d1eb8556ba\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"0ff92bb2237e3b49\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8bec4e78154fe10d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"a10563e2d0d6897a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9dd0f7917f110fb7\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"687ee6668b2aff86\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"f7dac6ef5dd1908c\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1f80f55153aa2924\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"7efc0eab2259376c\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"fcbbe896e61fb138\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"96be7f5895fe1ef7\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"ce8f97eb7688ca96\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"5b5099321ed7b42c\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"13deb8afe2e75654\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"950d77f568f56771\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"5ca469fb0a61dc29\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"c4fb20e5eb741d35\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"065c7b6deb01b0ce\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"dffe143fa2ae2b24\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"1fbf1e4c809c53d2\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"a508042dc0cdd316\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"dfa4bc7454a7a12d\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"ccf6d0acf1bd07e3\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"a6eb494f673d9d11\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"f382bec60280070f\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"b1250079fd461efc\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"03c138063fc02aad\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e38e7672589c813d\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"47fbc41d607b04d0\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"5c9517c8d9781675\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"037f3ce6de2e7d8e\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"81fb66a739f147aa\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"14fd2389e0233f08\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"465e9cd1b8c9d4ec\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"20e49b622e9c27f5\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"276d4c977426044e\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"8f33c24aaa2aa3df\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a85028308dc29754\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9dd06eb7ab6d251e\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"3be0488a1c71c8da\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"013b96ab36880ac0\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"2ab3d00c38111568\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"9c01d7ff09bfbb9b\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f252f8b2c30853ac\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"59b99e2b51a56d56\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"cefd9d8ed45ebb8f\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"10bd0bb3bcaeefd6\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"626fdf34696fd455\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"42962aba39e25cf6\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"55bee48227c4a67b\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"c4479e8751f2924a\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"bb84cd5403229546\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"906b69fc06c05dda\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"52fc314785585ca3\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"d815783d6dc40985\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"6e766395d8bfcb18\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"9333b69cb3593414\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"8c0b72bc814e0f06\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"95461b87111f345a\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"54451459d8de5b77\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"d471b0ce36360518\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"c469b2668efb21cf\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"f091c170b6a87b07\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"e4ff39a02803c211\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"82e0866183ae8ae2\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"0a3db867a79a1c3b\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"8405568f347a1f3e\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"04fa2ff6161b9189\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"631f16e5944636ec\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"65d41eefe582889d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"aa3850fed4ff1d86\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"29b5f29b99efe71a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"60934f72f18c30c5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7ef68e120aa263b3\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"37579a581bcf998c\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"c9ed2273c56bea70\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"a52580f3cd21c0da\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"594534cfe9cf5729\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"548482dc8c412e0b\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"36e6dfa5636868f3\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"99f032549f6f704a\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"91bc9ca624c19871\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"eacc6c8438274d2f\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"ec26edc15d57f4e1\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"fa273629792d6d5a\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"13c0d3900e47a687\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"3948f22a7d21c979\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"794caaf6c73738eb\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"7f7764e9a809381c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"e80162704a4c6c02\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"feef4673a87cdc5b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"040382be46c11364\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"dc52dc37b8606ff8\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"6f4ada5d53cc5fcf\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"15a5f84629110ca3\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"6523b0c945114bf1\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"6e2bb2f7c05088f1\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"056a693d2164e569\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"54f83ba640a746cb\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"6ff0ede9cb9cc2ee\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"a350d5f1100228b9\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"c391383160592212\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"0d73a8f3628deea8\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"32c4b67ab3e5fe0f\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c8522d4134f4de10\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"f9832e243f02aa02\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"1f113e41d628c76e\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"433c722d89a8b69a\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"b060132e641ae515\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"d8a5f55415e06740\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"80015af315e298e7\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f50003678dfc57ad\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"8faebc03bac7e18d\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"3a15a422ced7a7dc\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"e8375bcf83082a83\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"1f81f71d6b03161e\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"7aede9a7788491be\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"6bda90229bbc5e90\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"d07fc0b3becef413\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e0e547c6d8b32c43\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"c68ad5f6969a83cc\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"839ed0981fa6717a\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"d92b3f6c0880da9e\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"314b9c15cd15e1be\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"e7cf1e08589f9707\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"e6b10b51dfc1b4ec\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"f65fc408db188a59\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"9bd424d00a73c796\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"58b9cfe2c66907ec\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"127bfa6e182defa7\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"28037fbc444a104a\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"9895daebfcf897ee\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"544d323f1524ccee\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"7bd13751502bc347\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"94bd671fd197ac6c\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"0962c74aea105766\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"6d3a47fe27d71f9a\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"1fc05bfef772ce80\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"cd9fda6f81417dc7\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f8aea2b24bd59ca4\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bd2a91ee10ac64bd\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"79d490fd8d5ba66d\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"a88c351eb94a6544\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"852efcf3a87537d9\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"9e4ca28caa4c8510\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"5c7461288b1a89a2\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d34f5e469528a48b\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"fb431009ae053d14\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"773d8b1823162e54\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4ac5668d06bca39e\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"e60ee7eb13aa8706\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"6deccfacdf68ce95\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"086d2711810ce805\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"643915889cdc2b2a\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"e2084ef9ba56bc6e\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"57ef2a7c9f49616c\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"e7fa1b1f56bb7b6b\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"595fc9c2462c8813\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"4029b707e0dbb9f5\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"e9e714f1e84d203d\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"eb22d0e8f0f4aa3d\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"d2ba761db89f1cea\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"8a7d96f6c89bd0b3\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"13d04f2c459cbd13\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"554f609f94a610d0\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"c186dd3fd834ce8a\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"cf094e93d9a8af91\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"9dc63ed49b687229\",\"/knowledge-medium/src/plugins/geo/index.js\":\"b7ab0be87859c470\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"388e30f96462a698\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"45edca71c9889886\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"58ee027304689c06\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"3e878523824b79c1\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"889be40198d15290\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"eae7a43fd3bdc2e5\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"24d9320c0cb66773\",\"/knowledge-medium/src/plugins/geo/query.js\":\"73a18e189ef87309\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"9f62b9e597660355\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"58408158c4d24f98\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a5e38d459746797d\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"fbb51d0bbe876d88\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"ff5802454dbaf5e7\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"ed23d3175813915f\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"c89ae606cf2d0f85\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"13b2ab1206aea9bc\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"dfb2a0aeb9b5df29\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"841d45eb02a07b49\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"96c78c08a800cfa9\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"ffed584f8d868026\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"11a8f736afe64191\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9d87780e3a78c081\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"62ce5f31ac0f97db\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"d11f43b92edec30f\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"aefb864ee982a0c2\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"ebc5bb36b15749e6\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"2e816efbc1548957\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"4b7e929dc0a5b79d\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"d2873efa8dcfd901\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"e763bfa3b05b9d7a\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"726072bc50ab52b1\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"77e9b023d7e87e8e\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"047ac6f60f22f787\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"14c15ded045295af\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"1ab42fdff4218625\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"f888b14acb8bc76c\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"cd4e01ffe4a33c0e\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"f9ceb29398711015\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"8f40365632fdc2f0\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"65d1e4ce92ed5b63\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"378f4b82da8114c2\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"220778aa17428b46\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d1a8030d67c35843\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"ae72bc338b9042be\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"c023b58f58cf53ca\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"569bb48c4a9951b6\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"e5dc9ace1250b0af\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"ca1ec81d63ea93b2\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"feb211f5f74a59df\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"da4259347d25c38e\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"298a0ffa701f9471\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"a157b4abbdae38c3\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"27c27fc3810ab6f1\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"5f18b6da2284d076\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"87ddce63164bccde\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"f80f0819068d29fb\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"0f6919b888b90002\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"c891f81730dcbaa3\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"54c0f07422fb5d8e\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"881ccf94277f821d\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"1ce2be2ac85bc3ed\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"423a1ed2efd1a09c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"93b91040a2c070d6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"44659962435ef905\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"43d0491d85a85eaf\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"1759be69fba79ce8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"e9a3c0cc724ba1ca\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"87fbc808c46d76ee\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"62830effb3bbf389\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5ccb16c5f1600844\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ad62e22c1cf9ab97\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"2861be462eabcc1d\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"437f0d67042151e5\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"280af1dab6ce1643\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"5da959c417409b8c\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"4785295115d5b98a\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"88574c59d58886db\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"e8d8358dc30e2700\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"d9206e0e8c23b412\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"4896e08057d85c26\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"89a75d9f073fe050\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"011c63b36480a3af\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"82dff06a4536d814\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"c3f04e6881ae605c\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"0ab216308825aebd\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"3824e265f634f9b0\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"b9748238315b70e8\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"b57d5b63a52bddd5\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"cb28953aba4b5ea6\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"4555e46c561c0b4a\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"d6ff1f95ac55664c\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"916e959852461f59\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"2774e08d55ed8672\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"b0adaf677705ba83\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"d90f125c25fe468d\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"e7f40e21778f43e4\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"d53380f36d2f3982\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"d0de24294fa7ff9e\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"5f3d22fe9d0fd33b\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"70ea4d3fd8b88fc8\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"248662ca2ed93bcd\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"26fd9d6e17dbe6ed\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c721a0601a4d0a4d\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"4d55707f2b406fbe\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"8db20d52e4f837cc\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"2e3b7b1f674ee51d\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"ecd39a7e21402389\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"c19ea7d13be59b7d\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"527defa895f9c7ed\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"2c33b2e9c2d7280e\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"992cc9c22c6616db\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"2411d1387a02a1e7\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"d6b07a7d14ec1896\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"6fbede7d32fb8cec\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"d8a9d48ce953f9a4\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"2be931a8f604b203\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"712ec57cdc78c5d3\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"26bc9c0a807f20b4\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"1be3c0357ded4359\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"5a1daa562a14d6c9\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"329ce4dfbb4c6c34\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"2a5a60005a65854c\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"7e029d69c0fd5ef5\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"1a8ba4c841be8cd8\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"046892d78c5891a5\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"f01770f75b684446\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"ed27c42b6ddea607\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"6096eb45a717e1d7\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5767c46fe19b1de3\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"d3cc517ebaff88f7\",\"/knowledge-medium/src/plugins/recents/index.js\":\"1766637824b624cc\",\"/knowledge-medium/src/plugins/recents/target.js\":\"6e49737b01e2fa47\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"5984f77fe2e9b577\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"3b0e0f33879c3502\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"42aff5998ca54b80\",\"/knowledge-medium/src/plugins/references/index.js\":\"24db67193f33cf6e\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"edc2cd275829cf61\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"a703523243a87b99\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"b508cff9e47ce9e2\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"659b22d0275533e7\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f809e4af76e420d9\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"a81db13963e34338\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"1bbc86184424f3d1\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b1b52bb2f015a8c5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e07e3409cb868bc5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"e5605779574b2f28\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"df2f1a94afcc84b7\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ad25c8a404abcd12\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c318b413d0193e92\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"821a7b2dbeba6b29\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"ecd0d1d032a68de6\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"920fc57386c3b49b\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"6450cd5dcdfa4b67\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"1217a3c9d2fde75c\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"49cc06b5161d986b\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"4659be1e9c299e08\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"55d4f16faec45eb1\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8bde5bcbca2d569b\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"aafdddd2d573affa\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"54b48cae9fb01e92\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"af1abf7958eaaa89\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"e10ce93d773bd0f4\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"6db11e302035675b\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"8285855ee2d9bd7d\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"9717daebbb01e8c4\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"2be56fd677e0e533\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"b28599906a5bf7b8\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"5817fec09f35b3b4\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"b36a38609fb69d09\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"1dc9fe824ed11ec6\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"825108309c8a1a44\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"756d41b358e71271\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"5ff426b19435f55f\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"575639495809c434\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"4b275a76fa487df2\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"78fc8b1879fa63b3\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"16e7676f4f540d40\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"3c4a1fd7bef3449e\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"5db07abc56633494\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"2a270243ed1a7453\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"1b3cade1c1836a1e\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"8baf572f4aea7bef\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ef25a48786372512\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"daa07270c43eeaf1\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"e9b047156221c829\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"355e2718b284aa59\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"0da18b251c7f6896\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"26c78fba00ac0113\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"800de05057075021\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"671a4e9be10a3319\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ebf67dd8949ace8b\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"e45ad809cfcf3433\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"a445f7ca50be04b8\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"5a2a7187411d065e\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"9251a18d2280ea66\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d9d3c8d7f4a4964c\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"76c46c4adf4b5431\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"b287fb3ef67b1f45\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"0aedf99d71f91520\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"93c0dcccd4171b1a\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8a23a40405fb5fe9\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"4cb57ef806050664\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"1bd6a57ed145e9ca\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8b5d1ae37901a06b\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"2d3f2635b2d2c5ea\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"34b7b7241b38b24c\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b89c58f64d5d9341\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"04a9fcb7a6709942\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"901e7e1b4647c20d\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c01792246751d3fe\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"62cb34ca7f429004\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"c46ba575c6a65317\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"8523e8b8320e0eab\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"d08203b96f6cb910\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"fbb9a07e7179af2f\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"dd53fbbce0bbe832\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"e33e52479078b636\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"2c3397635e977049\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"d73495e333521827\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"9e695b0bccb7fc1f\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"ff539867f101dcde\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"c0a658176342e9cf\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"d9b793484abbb424\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"86a73d07ab969a29\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"2228ea9e1ee93154\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"cce2efb65ca3ba04\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"0ff6278e5a394c21\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"a1dc1d1c76856435\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"0788367feb68e412\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"70fbbb238cd7a804\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"caaf9aef4cceb0d5\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"2f1e9d846795d497\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"546722646f416a2a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"e0cec8dda4db87c8\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"d1f34d819f3db1e1\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"aa3a289394210aef\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"49e493bb632ec695\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"4fd80948fd56da03\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f9c704d7d8a7683d\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"092b4c67569c03a7\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"60e791842d451ca5\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"3375c7979e2aa391\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"9636bbafe7e3431e\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"20a9296e764844a1\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"2e858643cf246cb3\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"c12e28b1a794ebcd\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"c2254f461c7a0514\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"437611a1e741648a\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"6fa357d873c42943\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"92dfb5adf46404d2\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"436d64d7bd9da3e3\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"73f93f99e751d29b\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"a661a96d8e507ed0\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"e6143193235b2bf7\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"5fdbdbf637938e6e\",\"/knowledge-medium/src/plugins/todo/index.js\":\"13783219b7895724\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"4cbd0dee7428b3df\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9ed5457ab70b3ec2\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"edc027746409e5f1\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"d1ed60c53617c3ad\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"fc89205dc2fb7ffe\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"4c9c8f96111bfe39\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"0ff66e6b46358e79\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"7ec2d0541c284bb3\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"94b4e8ec6184cfd9\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"9a44eea571e04d4d\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"822e2f084928e8af\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"38e0fd478793c999\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"f7b5b8a26ac14034\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"5e28dedde364c29b\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"c0a4e73e155e5973\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"526e2c9e51f2f86e\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"3888f11febc70249\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"5d55a610384357f1\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"cb820c1323b9dd44\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"122e783caad9668f\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"d90389fedc3b1957\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"6fad602f2c1dc8c9\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"dc6c72185394ee11\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"a82d35522fe135cf\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"6df8e7a718549c63\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"5d7bbcd525ca4203\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"a262611d4af007e7\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"d1140c3a9e80261f\",\"/knowledge-medium/src/registerServiceWorker.js\":\"738acce8d352c63d\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"9cab93638be3297f\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"1aeff58f9eaac592\",\"/knowledge-medium/src/services/authStorage.js\":\"66ef49fcf8baa8fd\",\"/knowledge-medium/src/services/powersync.js\":\"d2f42cd471a79573\",\"/knowledge-medium/src/services/supabase.js\":\"7e7bd1b6a71d89a3\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"8d2bee0b020fc6cc\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"77c9835aa6eb880e\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"1204a41ee907599e\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"e413356b334fe6f8\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"3f4551a87e7c9f39\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"5d01378d0530a807\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"1061cf8f07e49d22\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"0711a9ac6d314fcf\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"0d2be33ad34ff3b5\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"1488fddeb8291103\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"5ef1789a7b9213e1\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"0796d76e2e3212ee\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"3fb882dd56702994\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"e3ff08d4958edd5b\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"35dd4cb33bdf65e0\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"985becb5594f6a37\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"dc772e10945c3537\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"876b2e6057945e8e\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"963aedca121b30af\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"ec9ef10d1a5e0c83\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"4df22c329dc60f0c\",\"/knowledge-medium/src/shortcuts/types.js\":\"1dc760fc67938b0f\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"28b4895ed32e515a\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"c68df62220a2f624\",\"/knowledge-medium/src/shortcuts/utils.js\":\"e165c4ac5b45997a\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"63a32c9c3ffc1cb9\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"ea89c053aac7d99a\",\"/knowledge-medium/src/sync/byteTransform.js\":\"18fecfdd0e77cfdc\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"da58ff7519368353\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"bcae6d06fe0a0419\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"2d3cdd36ac7c7713\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"34f380fc19ee5b75\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"6deab2f4f4fcaab9\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"79a70da49756eff6\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"34518b085600bcec\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"9539c1e033245026\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"dd174a9a2b638f14\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"83986be49a140eff\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"1b852d3bf38ab45b\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"6d680dba5aa923a7\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"16d55f276db61abe\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"091d47d0ba254558\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"ce652ec354d1961b\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"b9b066e9373362e7\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"0f08239b830d6d2f\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"00fc965ea438f722\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"d896e96bf891abff\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"19593d6519531021\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"f19e4f40311b3316\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"18f26b9682dfd5e9\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"37efb04316247d91\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"0ce91d5f8bfe236e\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"95ef215549afccd9\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"150e3cab307120e6\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"16524f029932ddbf\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"c0191a162f7c2a60\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"69288584d86d248b\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"b6c0c61c7da31e9b\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"6385c4acea9158c6\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"fa9b4fcbbc6845e5\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"42062447df004e85\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"395a1a00cbb9d2c3\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"e294648e7e3f9d15\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"f8121961d4a468e2\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9ea5136951b70e76\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"c7960abf54558aa8\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b90c276a775d1707\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"528d4d97ace32510\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"33da908957f5aa0e\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"705d3f2e2917da81\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"fdb7804a7d7c6810\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"cbd1b670a8b2d3ac\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"c109cc865c52afef\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"2b943be41028c85c\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"53558ac207ab9fba\",\"/knowledge-medium/src/sync/transform.js\":\"c70b182ea1ee2e02\",\"/knowledge-medium/src/themeBootDefaults.js\":\"1d4ea1c2375815c7\",\"/knowledge-medium/src/types.js\":\"c832b9a06bec5d45\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"c1af41a8463ecb2f\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"df5e9c8f6862fa88\",\"/knowledge-medium/src/utils/array.js\":\"8b08e8aef41a00c5\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"8eaa3a4281ddfa82\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"afbef5e62bd77572\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"5fc3905f18d5c74d\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"f2da89708573d023\",\"/knowledge-medium/src/utils/callbackSet.js\":\"23641e0f9148dca7\",\"/knowledge-medium/src/utils/clientId.js\":\"32c5bd20c397cb6f\",\"/knowledge-medium/src/utils/codemirror.js\":\"fadc645476f01d48\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"69f32bf43bf246ab\",\"/knowledge-medium/src/utils/copy.js\":\"41c2a10271ec00d2\",\"/knowledge-medium/src/utils/dailyPage.js\":\"2e9afc36cf9de236\",\"/knowledge-medium/src/utils/dbForensics.js\":\"81686fa49a6e02ad\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"0d374341ae793adb\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"a124751f648a67b3\",\"/knowledge-medium/src/utils/dialogs.js\":\"75d203a38f2c7166\",\"/knowledge-medium/src/utils/dom.js\":\"dc249da49a94d062\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"118ea28f5428500a\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"29b6bc150812a4d6\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"3315cc81cafefff6\",\"/knowledge-medium/src/utils/flipSlide.js\":\"89caf6e6f9c5e453\",\"/knowledge-medium/src/utils/fnv1a.js\":\"5ddbe4d3ad8e5a02\",\"/knowledge-medium/src/utils/formatBytes.js\":\"3b768ca359dee06b\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"b7361bcec168fc53\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"40f4ceeac6e32476\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"c43aa338fe613934\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"9b822a84ed67402a\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"870765050aeb5d3e\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"1eac8179f05469d9\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"da2da2c79ddf88c4\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"d149b95f83ae105b\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"3a1554f441ea8053\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"5d63892cb869e2ab\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"8b4b48fe62085a22\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"2e652f0ef019dc47\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"225d22806fed2f4c\",\"/knowledge-medium/src/utils/markdownParser.js\":\"782d57f9dabb533a\",\"/knowledge-medium/src/utils/memoize.js\":\"eadbd9aa3e94e4f9\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"c29d8e0faf8d4186\",\"/knowledge-medium/src/utils/nameList.js\":\"93743b65b2485c79\",\"/knowledge-medium/src/utils/navigation.js\":\"36a5e5826d64ae91\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"36759534181858e9\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"987cafaa80527cc5\",\"/knowledge-medium/src/utils/panelClearance.js\":\"9129820bfb5d8df5\",\"/knowledge-medium/src/utils/panelHistory.js\":\"0b4dd9f84a5cccbb\",\"/knowledge-medium/src/utils/panelLanes.js\":\"66f59b53b1b9f062\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"6c46df5cb86b7684\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"64a732145b60dcc8\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"2780aa1853e1237f\",\"/knowledge-medium/src/utils/platform.js\":\"4ef0d7796dce6c68\",\"/knowledge-medium/src/utils/pluralize.js\":\"2dbdfb3286519692\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"8680b85d661fdb13\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"8004cd80821cfaeb\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"ff74f7b4c073c9c7\",\"/knowledge-medium/src/utils/react.js\":\"127e3cdd329d2552\",\"/knowledge-medium/src/utils/relativeDate.js\":\"df8ca6e0aa900b9e\",\"/knowledge-medium/src/utils/relativeTime.js\":\"ccb6786194bd0cc2\",\"/knowledge-medium/src/utils/renderScope.js\":\"b8babba57ee53fbc\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"9b95b78c27c8b961\",\"/knowledge-medium/src/utils/routing.js\":\"cf234cafc6927a42\",\"/knowledge-medium/src/utils/safeMode.js\":\"e323db64c8790374\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"5706d73d0a70d7cf\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"d0df2fc4d431577f\",\"/knowledge-medium/src/utils/selection.js\":\"e9918dd81cb2ce47\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"49135e7d2bc6dac1\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"4348056ed60c4846\",\"/knowledge-medium/src/utils/state.js\":\"555e47fd26fa7113\",\"/knowledge-medium/src/utils/string.js\":\"5b6ee853593abdc2\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"9b2287075b830db9\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"642078812458d50f\",\"/knowledge-medium/src/utils/toast.js\":\"aa62d943da0047c6\",\"/knowledge-medium/src/utils/toggleStore.js\":\"7861c4a84503ea19\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"fc4a492ebb6591b3\",\"/knowledge-medium/src/utils/userActivity.js\":\"fec537b31a5f6307\",\"/knowledge-medium/src/utils/viewTransition.js\":\"7864ff5e67c15dae\",\"/knowledge-medium/src/utils/viewport.js\":\"e51f93f84840513c\",\"/knowledge-medium/src/utils/webLock.js\":\"ac9d2db9616778b0\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"3b4e9c2bb1bfc0a1\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"702af2eb5eb0e77f\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"d1c341cdfbf2fc2b\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"0fdc46e80b4c1ac0\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"17f0f2eed983d67a\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"fe8d0d7d9ac14f5f\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"8a07295d0a31cf54\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"35fd4965177c0a54\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"c223d38fe6f3b786\",\"/knowledge-medium/src/vendor/react-dom.js\":\"49cd9b8357083ca8\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"02d9b386cce695b2\",\"/knowledge-medium/src/vendor/react.js\":\"76dfec59cf9d2e42\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
