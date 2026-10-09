# Steam regression fixtures

Recorded on 2026-10-09 from the JP Steam store, with `l=japanese`.

- `pony-search.html`: `/search/results/`, `specials=1&maxprice=free&category1=998`.
- `pony-details.json`, `core-details.json`: `/api/appdetails` for apps 405640 and 1621690; only fields used in verification are retained.
- `pony-license.html`: the free-license purchase section from `/app/405640/`.
- `fireside-license-utc.html`: the free-license purchase section for app 2990600, recorded with `l=english` and `timezoneOffset=0,0`. The anonymous session input is removed. Its text deadline is 2026-10-12 17:00 UTC.
- `core-browse.json`: `IStoreBrowseService/GetItems/v1/` for app 1621690.
- `paid-news-samples.json`: official `ISteamNews/GetNewsForApp/v2/` announcements for apps 2236920, 4319430 and 5257350, including Steam's relay URL and `is_external_url=true` metadata.
- `featured.json`: promotion categories from `/api/featuredcategories`.

The scan test moves the recorded free-weekend period around the current time so it does not expire. Other tests verify the original start and end boundaries using explicit times.
