# @hopline/importers

Pure session importers for Hopline (SecureCRT, MobaXterm, PuTTY, ssh_config,
CSV, NetBox/Nautobot) and the import diff planner. No I/O except the NetBox
fetch, which takes an injectable `fetch`.

## Contract notes for callers

### NetBox / Nautobot (`fetchNetBox`)

- The API token is only sent to the origin of `url`. `next` links are rebased
  onto that origin (path and query only), and every request URL is checked
  against it before the request is made.
- **An incomplete pull throws.** If the pages hold fewer devices than the
  API's `count`, `fetchNetBox` rejects with a `NetBoxError` of kind `format`
  ("Incomplete device list: ..."), the same as for an HTTP error mid-pagination.
  It never returns a partial result, because re-sync would read the missing
  devices as deletions. There is no flag to check; handle the rejection.

### CSV (`importCsv`)

- Columns whose title is a password alias (`password`, `pass`, `secret`) or
  names a password, passphrase or secret (`Enable Secret`, `SSH Password`,
  `passwd`, `pwd`) never feed any session field. An explicit mapping onto such
  a column (by index or title) is dropped with a warning, like a mapping to a
  missing column; the rest of the import goes ahead. Unknown mapping fields are
  dropped with a warning too.
- **`headerless: true`** is set on the result (`CsvImportResult`) whenever row 1
  is read as data (`hasHeader: false`, or an index-only mapping without
  `hasHeader`). Secret columns can only be recognised by their title, so the
  app should warn the user that a mapped column might hold passwords.
