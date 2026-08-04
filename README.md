# Lucid datetime handling on SQLite

A minimal AdonisJS 7 app reproducing a set of datetime defects that appear on SQLite and not on PostgreSQL.

Every test here passes on PostgreSQL. On SQLite, most of them fail. Since SQLite is the default database in a fresh AdonisJS install, this is what most people meet first.

```
                                 sqlite          postgres
toSQL()                          4 rows          3 rows
toISO()                          6 rows          3 rows
toJSDate()                       0 rows          3 rows
a DateTime                       throws          3 rows
toFormat(dateTimeFormat)         3 rows          3 rows
a row found by what saved it     throws          found
milliseconds after a round trip  .000            .456
how Lucid and knex store it      text vs number  timestamp vs timestamp
autoCreate fills created_at      yes             yes
date-only column (contrast)      3 rows          3 rows
```

Where a row count is shown, the query asks for the same three rows, so `3 rows` is the right answer.

The fix is to let a where clause take a Luxon `DateTime`. See [What I would suggest](#what-i-would-suggest), which links a working branch.

## Running it

```sh
npm install

# sqlite, the default: 8 passed, 12 failed
node ace test

# postgres, for contrast: 20 passed
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5436:5432 postgres:16
DB=pg PG_PORT=5436 node ace test
```

Two test files, one `events` table, two models:

| File                                | Model                                                                                                     | What it shows                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `tests/unit/datetime.spec.ts`       | `app/models/event.ts`, using the stock `@column.dateTime()` and `@column.date()`                          | the defects                                           |
| `tests/unit/knex_converted.spec.ts` | `app/models/knex_converted_event.ts`, the same table and column with only `prepare` and `consume` changed | what changing the storage fixes, and what it does not |

Run either on its own:

```sh
node ace test --files="datetime"          # 3 passed, 7 failed
node ace test --files="knex_converted"    # 5 passed, 5 failed
```

## The root cause

Lucid saves a datetime as text, in a format that changes per database, chosen by `dialect.dateTimeFormat`:

```
sqlite, mysql, oracle     yyyy-MM-dd HH:mm:ss           "2026-01-01 18:00:00"
pg, mssql, redshift       yyyy-MM-dd'T'HH:mm:ss.SSSZZ   "2026-01-01T18:00:00.000Z"
```

PostgreSQL turns that string into a real `timestamp`, so it compares actual dates and everything works. SQLite has no date type, so the value stays text and it compares text instead. Anything you pass that doesn't match the saved format exactly gives a wrong answer rather than an error.

That one choice produces the first three defects below. The fourth is what happens when knex, which never made that choice, writes to the same column.

## The defects

### There is no obvious way to write a datetime comparison correctly on SQLite

Six rows on the hour from 18:00 to 23:00, asking for those before 21:00, so the answer is three:

```ts
await Event.query().where('startsAt', '<', cutoff)
// what should cutoff be?
```

| What you pass       | SQLite result | Why                                                                                                                                                               |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dt.toSQL()`        | **4**         | `"2026-01-01 21:00:00"` is a prefix of `"2026-01-01 21:00:00.000 +00:00"`, so the boundary row sorts below it and is included                                     |
| `dt.toISO()`        | **6**         | `T` sorts above the space separator, so every stored value sorts below it                                                                                         |
| `dt.toJSDate()`     | **0**         | knex turns a `Date` into a number, and SQLite always sorts numbers before text, so nothing matches                                                                |
| `dt` (a `DateTime`) | **throws**    | `SQLite3 can only bind numbers, strings, bigints, buffers, and null`                                                                                              |
| `dt.toFormat(fmt)`  | **3**         | correct, because it matches the format the value was saved in, but you have to go and get that format first: `const fmt = db.connection().dialect.dateTimeFormat` |

Three of the first four give a wrong answer with no error at all. Only the `DateTime` one tells you something is wrong, and only on `better-sqlite3`. The `sqlite3` driver converts the object instead and returns every row.

The last one is correct, and works on both databases. But you have to reach through the connection to the dialect to find out what format your own value was saved in, it appears in no documentation, and it is not what anyone writes first. It is also fragile: it is correct only for as long as the value is saved as text in that exact format, so it stops working the moment the storage changes, which the second test file shows.

The `DateTime` row is the interesting one for a fix, because Lucid already knows how to format a `DateTime` for each database. It does it when saving, in `prepareDateTimeColumn`, and not when querying, so `transformValue` hands a Luxon object straight to the driver.

That it works on PostgreSQL at all is a coincidence, not support. Lucid passes the Luxon object through untouched, `pg` does not recognise it so falls back to `JSON.stringify`, which produces `"2026-01-01T21:00:00.000+00:00"` with the quote characters included, and PostgreSQL's date parser ignores stray quotes:

```
postgres=# select '"2026-01-01T21:00:00.000+00:00"'::timestamptz;

 2026-01-01 21:00:00+00
```

Three lenient steps happening to cancel out. Nothing in that chain is deciding to support a `DateTime` here.

This repository reproduces the problem on SQLite, but SQLite is not the only database affected. Running the same checks as a test file inside Lucid's own suite, against every database that project tests, gives this at the current `22.x` commit:

```
sqlite           1 passed, 7 failed
better-sqlite3   1 passed, 7 failed
libsql           1 passed, 7 failed
mssql 2019       1 passed, 7 failed
mysql 8.0        8 passed
mysql 5.7        8 passed
postgres 16      8 passed
```

MSSQL fails in the same seven places. It also uses the same `dateTimeFormat` as PostgreSQL, so the split is not about the format string. It is about whether the driver happens to turn a Luxon object into something the database will accept. `pg` and `mysql` do, by the accident described above. The SQLite drivers and `tedious` do not.

### A row cannot be found by the value that saved it

```ts
await Event.create({ name: 'only', startsAt: instant })
await Event.query().where('startsAt', instant).first() // throws on sqlite
```

This one needs no cross-dialect comparison to look wrong. Lucid formats the value on the way in and passes it through untouched on the way out, so the two ends never meet.

### Milliseconds are thrown away when saving

`yyyy-MM-dd HH:mm:ss` has nowhere to put milliseconds, so they are lost when saving and cannot be recovered.

```
written   2026-01-01T18:00:00.456Z
read back 2026-01-01T18:00:00.000+00:00
```

Nothing about SQLite forces this. It saves whatever text it is given, and a format that includes milliseconds sorts and compares just as correctly.

Four values saved as text with milliseconds, sorted by SQLite:

```
2026-01-01 18:00:00.456
2026-01-01 19:00:00.999
2026-01-01 20:00:00.001
2026-01-01 21:00:00.000
```

Asking for the ones before `2026-01-01 21:00:00.000` returns the first three, which is the right answer.

So this is down to the format Lucid picked, not something the database can't do. The same complaint was raised for MySQL in [#636](https://github.com/adonisjs/lucid/issues/636), with [#637](https://github.com/adonisjs/lucid/pull/637) attached; the PR was closed unmerged and the issue was closed by the stale bot.

### Lucid and knex save the same value differently

Write the same instant through each layer of the same stack and the column ends up holding two different types at once. SQLite allows that: a column's declared type is a hint about what to prefer, not a rule it enforces, so rows in one column can hold whatever each write happened to pass.

Asking SQLite itself what it is holding, after one row written through Lucid and one through knex:

```
sqlite> select name, typeof(starts_at), starts_at from events;

viaLucid|text|2026-01-01 18:00:00
viaKnex|integer|1767290400000
```

knex's `better-sqlite3` client converts a `Date` with `binding.valueOf()`, in its `_formatBindings`. Lucid's column layer formats to text instead. Both are reasonable in isolation, and together they are why `toJSDate()` finds nothing: it passes a number, and the rows Lucid wrote are text.

This turns up in shipped packages. `@adonisjs/cache` writes its `expires_at` through knex, so on SQLite that column holds numbers.

Say two entries are cached at noon on 4 August, one expiring an hour later and one the next day. knex saved each `Date` as a number, so the column holds:

```
a  1785848400000
b  1785931200000
```

Now ask which of them have expired, written the way you would for any datetime column:

```ts
const cutoff = DateTime.now().toSQL()
// '2026-08-04 12:00:00.000 +00:00'

const expired = await db.from('cache').where('expires_at', '<', cutoff)
// [ { key: 'a', expires_at: 1785848400000 },
//   { key: 'b', expires_at: 1785931200000 } ]
```

Both come back, and neither has expired. The value passed is text, the column holds numbers, and SQLite sorts numbers before text, so the condition is true for every row however far in the future it expires. Nothing errors.

## What changing the storage does and does not fix

`app/models/knex_converted_event.ts` maps the **same table and column**, changing only how the value is handed to knex:

```ts
@column({
  prepare: (value: DateTime | null) => (value ? value.toJSDate() : value),
  consume: (value: unknown) => { /* Date | number | string -> DateTime */ },
  meta: { type: 'datetime' },
})
declare startsAt: DateTime | null
```

Nothing about a `Date` object reaches the database. knex converts it, so SQLite ends up with a number and PostgreSQL with a timestamp, exactly as it already does anywhere else a `Date` is passed.

`tests/unit/knex_converted.spec.ts` runs the identical tests against it. On SQLite, five of the ten pass where three passed before:

```
                                 saved as text   saved as a number
toSQL()                          4 rows          6 rows
toISO()                          6 rows          6 rows
toJSDate()                       0 rows          3 rows
a DateTime                       throws          throws
toFormat(dateTimeFormat)         3 rows          6 rows
a row found by what saved it     throws          throws
milliseconds after a round trip  .000            .456
how Lucid and knex store it      text vs number  number vs number
autoCreate fills created_at      yes             yes
date-only column (contrast)      3 rows          3 rows
```

Again, where a row count is shown, three is the right answer.

**Fixed.** Milliseconds survive, because a number has room for them. Lucid and knex now save the same value the same way, because both hand knex a `Date`. And passing `toJSDate()` works, because both ends are now numbers.

**Not fixed.** `toSQL()` and `toISO()` still return the wrong rows, and a bare `DateTime` still throws, so a row still cannot be found by the value that saved it. None of those are about how the value is saved. They are about what gets passed to the query, and Lucid formats a `DateTime` when saving but not when querying.

It also breaks `toFormat(dateTimeFormat)`, which went from correct to wrong. That was the one that worked, and it only worked because it matched the text format the value was saved in. Change the storage and it stops matching.

So changing the storage on its own is not enough: every query would still need `.toJSDate()` by hand. The two have to move together, which is what the branch linked below does.

The cost of the storage change is readability. A raw `SELECT` on SQLite shows `1767290400000` instead of a date you can read.

## What I would suggest

**Let a where clause take a Luxon `DateTime`.**

```ts
await Event.query().where('startsAt', '<', someDateTime)
```

Lucid already knows how to turn a `DateTime` into what a column stores, because it does exactly that when saving. It just does not do it when querying, so the value goes to the driver untouched. Doing it on both sides means nobody has to know what `toSQL()`, `toISO()` or `dialect.dateTimeFormat` are, and the three silently wrong ways to write it stop being reachable.

### It needs one tidy-up first

Five places each turn a `DateTime` into a stored value their own way: both column decorators, the many-to-many pivot timestamps, and the helper `base_model` uses. All five do `value.toFormat(dialect.dateTimeFormat)` separately. Nothing keeps them in step, which is how saving and querying came to disagree.

Put that decision in one function, and let the dialect take it over if it wants to:

```ts
formatDateTime?(value: DateTime): string | number
formatDate?(value: DateTime): string | number
parseDateTime?(value: unknown): DateTime | undefined
parseDate?(value: unknown): DateTime | undefined
```

These are optional, so no existing dialect changes and nothing behaves differently without them.

The where clause change is then small: thread the column name through to where the value is converted, and format it the way that column saves.

### Storing datetimes as numbers then costs one method

```ts
formatDateTime(value: DateTime) {
  return value.toMillis()
}
```

Saving and querying both follow, because both go through the same function. Datetimes compare as numbers, sort correctly, and keep the milliseconds the text format has no room for. Dates stay as ISO text, since a date has no time and reads fine as text.

### A working branch

All of it, on top of `22.x`:

**https://github.com/adonisjs/lucid/compare/22.x...evoactivity:fix/datetime-where-bindings**

Four commits: the failing test, the tidy-up, the where clause change, then the storage change. The first three stand without the fourth.

Run against every database the project tests, using its own `compose.yml`:

```
sqlite           1500 passed
better-sqlite3   1498 passed
libsql           1486 passed
mysql 8.0        1533 passed
mysql 5.7        1467 passed
mssql 2019       1474 passed, 3 failed
postgres 16      1555 passed
```

MSSQL is the only one with anything left, and it is the same there at the base commit. One is an `updateOrCreateMany` test that asserts on `$isLocal` rather than on a query. The other two are `db:drop` tests that pass or fail between runs on timing alone. Nothing datetime-related fails anywhere as a result of the change.

One existing test needed a line: it rebuilt a `DateTime` from the raw column while testing `autoCreate`, so it had the storage form baked into it.

Reading rows is a hot path, and asking the dialect on every row cost 12% of hydration time, so the parse helper checks the shapes every dialect already returns before asking, and takes the dialect as a getter rather than a value.

Data already saved is the real cost of the storage change. Text rows read back fine, but comparisons against them would need a migration.

## Versions

```
@adonisjs/core   7.3.3
@adonisjs/lucid  22.4.2
knex             3.3.0, better-sqlite3 dialect
```
