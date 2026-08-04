import KnexConvertedEvent from '#models/knex_converted_event'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * The exact same tests as datetime.spec.ts, in the same order, with the
 * same assertions. The only difference is the model: this one saves the
 * column hands knex a JS Date instead of a preformatted string.
 *
 * Six events, on the hour from 18:00 to 23:00 UTC. Every query below asks
 * for the ones before 21:00, so the correct answer is always three.
 */
const BASE = DateTime.fromISO('2026-01-01T18:00:00Z')
const BOUNDARY = DateTime.fromISO('2026-01-01T21:00:00Z')

async function seed() {
  for (let i = 0; i < 6; i++) {
    await KnexConvertedEvent.create({ name: `E${i}`, startsAt: BASE.plus({ hours: i }) })
  }
}

test.group('1. Comparisons work on both databases', (group) => {
  group.each.setup(() => testUtils.db().withGlobalTransaction())

  test('a toSQL() binding returns the right rows', async ({ assert }) => {
    await seed()
    const rows = await KnexConvertedEvent.query().where('startsAt', '<', BOUNDARY.toSQL()!)
    assert.lengthOf(rows, 3)
  })

  test('a toISO() binding returns the right rows', async ({ assert }) => {
    await seed()
    const rows = await KnexConvertedEvent.query().where('startsAt', '<', BOUNDARY.toISO()!)
    assert.lengthOf(rows, 3)
  })

  test('a toJSDate() binding returns the right rows', async ({ assert }) => {
    await seed()
    const rows = await KnexConvertedEvent.query().where(
      'startsAt',
      '<',
      BOUNDARY.toJSDate() as never
    )
    assert.lengthOf(rows, 3)
  })

  test('a DateTime binding returns the right rows', async ({ assert }) => {
    await seed()
    const rows = await KnexConvertedEvent.query().where('startsAt', '<', BOUNDARY as never)
    assert.lengthOf(rows, 3)
  })

  /**
   * This one works. It is the only one that does, and it means reaching
   * into the connection for the format Lucid saved the value in.
   */
  test('a toFormat(dialect.dateTimeFormat) binding returns the right rows', async ({ assert }) => {
    await seed()
    const format = db.connection().dialect.dateTimeFormat
    const rows = await KnexConvertedEvent.query().where('startsAt', '<', BOUNDARY.toFormat(format))
    assert.lengthOf(rows, 3)
  })
})

test.group('2. A value can be found by what saved it', (group) => {
  group.each.setup(() => testUtils.db().withGlobalTransaction())

  test('a row is found by the value that saved it', async ({ assert }) => {
    await KnexConvertedEvent.create({ name: 'only', startsAt: BOUNDARY })

    const found = await KnexConvertedEvent.query()
      .where('startsAt', BOUNDARY as never)
      .first()
    assert.isNotNull(found)
  })
})

test.group('3. Milliseconds survive', (group) => {
  group.each.setup(() => testUtils.db().withGlobalTransaction())

  test('sub-second precision survives a round trip', async ({ assert }) => {
    const precise = DateTime.fromISO('2026-01-01T18:00:00.456Z')
    const event = await KnexConvertedEvent.create({ name: 'precise', startsAt: precise })

    const reread = await KnexConvertedEvent.findOrFail(event.id)
    assert.equal(reread.startsAt!.toISO(), precise.toISO())
  })
})

test.group('4. Lucid and knex agree on how a value is saved', (group) => {
  group.each.setup(() => testUtils.db().withGlobalTransaction())

  test('both layers write the same instant the same way', async ({ assert }) => {
    const instant = DateTime.fromISO('2026-01-01T18:00:00Z')

    // written through Lucid's column layer
    await KnexConvertedEvent.create({ name: 'viaLucid', startsAt: instant })

    // the same instant written through knex, as @adonisjs/cache does
    await db.table('events').insert({ name: 'viaKnex', starts_at: instant.toJSDate() })

    const rows = await db.from('events').select('name', 'starts_at').orderBy('name')

    const viaKnex = rows.find((r: any) => r.name === 'viaKnex')!.starts_at
    const viaLucid = rows.find((r: any) => r.name === 'viaLucid')!.starts_at

    assert.equal(
      typeof viaKnex,
      typeof viaLucid,
      `knex stored a ${typeof viaKnex} (${JSON.stringify(viaKnex)}), ` +
        `Lucid stored a ${typeof viaLucid} (${JSON.stringify(viaLucid)})`
    )
  })
})

test.group('5. autoCreate and autoUpdate still work', (group) => {
  group.each.setup(() => testUtils.db().withGlobalTransaction())

  test('created_at is filled in automatically', async ({ assert }) => {
    const event = await KnexConvertedEvent.create({ name: 'stamped' })
    assert.isNotNull(event.createdAt)
  })
})

test.group('6. Date-only columns work (contrast)', (group) => {
  group.each.setup(() => testUtils.db().withGlobalTransaction())

  test('a date-only column compares correctly', async ({ assert }) => {
    const day = DateTime.fromISO('2026-01-01')
    for (let i = 0; i < 6; i++) {
      await KnexConvertedEvent.create({ name: `D${i}`, releasedOn: day.plus({ days: i }) })
    }

    const rows = await KnexConvertedEvent.query().where(
      'releasedOn',
      '<',
      DateTime.fromISO('2026-01-04').toISODate()!
    )
    assert.lengthOf(rows, 3)
  })
})
