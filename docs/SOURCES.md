# Sources

Every source is an adapter in `server/src/modules/sources/adapters/` implementing `SourceAdapter`
(`adapter.ts`): an id, capabilities, rate limit, access notes, `missingConfiguration(env)` and, if it can
search, `search(query, http)`. Adapters only report what the source states; they never infer a creator
or date. All requests go through the guarded HTTP client (GET only, SSRF checks, retries with backoff,
`Retry-After`, per-source token bucket).

**Verification status.** The build environment had no outbound network, so no adapter has made a live
request yet. All of them show *unverified* in the app until **Sources → Test connection** succeeds on
your server. Their parsing is covered by tests that use responses shaped like each API's documented
format; the fixtures are synthetic.

| Source | Endpoint | Credentials | Notes |
|---|---|---|---|
| Wikimedia Commons | `commons.wikimedia.org/w/api.php` (search in File namespace + `extmetadata`) | None. Set `SOURCE_CONTACT` (Wikimedia's User-Agent policy) | Author, date, licence per file; licences vary |
| Internet Archive | `archive.org/advancedsearch.php`; thumbnails from `archive.org/services/img` | None. `SOURCE_CONTACT` recommended | Metadata is uploader-supplied, so baseline reliability is lower |
| Art Institute of Chicago | `api.artic.edu/api/v1/artworks/search`, then `/artworks?ids=`; IIIF images | None (`AIC-User-Agent` header sent) | Metadata CC0; only public-domain images are freely reusable |
| Flickr | `api.flickr.com/services/rest/` (`flickr.photos.search`) | `FLICKR_API_KEY` | Uploader is the account owner, not always the photographer; previews are hot-linked, not stored |
| Tumblr | `api.tumblr.com/v2/tagged` | `TUMBLR_API_KEY` (OAuth consumer key) | Searches one tag; the posting blog is recorded as "posted by", never as creator |
| RSS / Atom | Feeds you add on the Sources page | None | Feed is fetched once to validate before saving; only recent entries are searchable |
| Manual URL | Any public page you paste | None | Reads OpenGraph/meta tags; private and local addresses are refused |
| Wikidata | `www.wikidata.org/w/api.php` | None | Knowledge graph only (not a reference source). Its statements are stored as *documented* relations |

Instagram is intentionally absent: its API cannot search other accounts and scraping is not
permitted. Pinterest, Are.na and similar sites can be added later as adapters if they offer an API you
have access to.

## Adding a source

1. Create `adapters/<name>.ts` implementing `SourceAdapter`; map fields into `DiscoveredItem` without
   guessing missing values.
2. Register it in `registry.ts` (`ADAPTERS`). `syncSources()` creates its row on start.
3. Add a test with a fixture shaped like the real response, labelled synthetic.
4. Run **Test connection** on the server before relying on it.
