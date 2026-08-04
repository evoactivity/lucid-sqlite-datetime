import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * The same `events` table, but the datetime columns hand knex a JS Date
 * instead of a preformatted string, and let knex decide what to store.
 *
 * Nothing here is new machinery: knex already knows how to convert a Date
 * for each database, so SQLite gets a number (via `binding.valueOf()` in
 * the better-sqlite3 client) and PostgreSQL gets a timestamp. The only
 * change is that Lucid stops turning it into text first.
 *
 * `createdAt` and `updatedAt` use the same custom column, with
 * `meta.autoCreate` and `meta.autoUpdate` set by hand, so the tests really
 * do check that filling in the time still works when the formatting is
 * ours rather than Lucid's.
 *
 * The name is about who does the converting, not about what ends up in the
 * column: on SQLite that is an epoch number, on PostgreSQL a timestamp.
 */
const convertedByKnex = {
  prepare: (value: DateTime | null) => (value ? value.toJSDate() : value),
  consume: (value: unknown) => {
    if (value === null || value === undefined) return value
    if (value instanceof Date) return DateTime.fromJSDate(value)
    if (typeof value === 'number') return DateTime.fromMillis(value)
    return DateTime.fromSQL(String(value))
  },
  serialize: (value: DateTime | null) => (value ? value.toISO() : value),
}
export default class KnexConvertedEvent extends BaseModel {
  static table = 'events'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column({ ...convertedByKnex, meta: { type: 'datetime' } })
  declare startsAt: DateTime | null

  @column.date()
  declare releasedOn: DateTime | null

  @column({
    ...convertedByKnex,
    meta: { type: 'datetime', autoCreate: true },
  })
  declare createdAt: DateTime

  @column({
    ...convertedByKnex,
    meta: { type: 'datetime', autoCreate: true, autoUpdate: true },
  })
  declare updatedAt: DateTime | null
}
