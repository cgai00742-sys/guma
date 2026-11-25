/**
 * Start a project from where the work turned up -- a print waiting in
 * Prints to check whose project does not exist yet (CG, 25 Nov 2026: "let
 * there be an option for the user to create a new project if they don't see
 * the project listed ... This should also be an option for Client made
 * projects").
 *
 * The shop's own work is just a name. Client work is a client and a name,
 * and it goes straight onto the board at Intake rather than being left as
 * a draft: the printing has already happened, so this is work the shop is
 * doing, not an enquiry it might take. It carries a DRAFT quote with no
 * price in it -- nothing is guessed -- so the Intake gate still asks for a
 * quote before anything moves, exactly as for any other client project.
 */
import type * as Local from './data.local'
import type { ShopContext } from './data.types'

export type StartApi = Pick<typeof Local, 'listJobs' | 'listClients' | 'createInHouseJob' | 'nextJobRef' | 'saveQuote' | 'takeProjectIn'>

export type StartInput = { kind: 'inhouse'; title: string } | { kind: 'client'; title: string; clientName: string }

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** A project already called this, so the person picks it rather than
 *  making a second one. Delivered work counts: reusing a name for new work
 *  is still worth a second look. */
export async function projectNamed(ctx: ShopContext, api: Pick<StartApi, 'listJobs'>, title: string): Promise<{ jobId: string; title: string } | null> {
  const j = (await api.listJobs(ctx.shop.id)).find((x) => same(x.title, title))
  return j ? { jobId: j.jobId, title: j.title } : null
}

/** The client by name, as Guma would match it on saving: exact, any case. */
export async function clientNamed(ctx: ShopContext, api: Pick<StartApi, 'listClients'>, name: string) {
  return (await api.listClients(ctx.shop.id)).find((c) => same(c.name, name)) ?? null
}

export async function startProject(ctx: ShopContext, api: StartApi, input: StartInput, from: string): Promise<string> {
  const title = input.title.trim()
  if (!title) throw new Error('Give the project a name.')
  const dupe = await projectNamed(ctx, api, title)
  if (dupe) throw new Error(`You already have a project called “${dupe.title}” — pick it from the list.`)
  if (input.kind === 'inhouse') return api.createInHouseJob(ctx.shop.id, { title })

  const clientName = input.clientName.trim()
  if (!clientName) throw new Error('Say who the client is.')
  if (same(clientName, 'in-house')) throw new Error('“In-house” is your own work — choose Your own work instead.')
  const saved = await api.saveQuote({
    shopId: ctx.shop.id,
    ref: await api.nextJobRef(ctx.shop.id),
    // Blank details keep whatever is on file for an existing client.
    client: { name: clientName, contact: '', email: '', phone: '', source: '' },
    job: {
      title,
      brief: `Started from ${from} — printed before it was quoted. Quote it to move it on.`,
      neededBy: null,
      assetOrigin: 'ready',
    },
    // A draft with nothing priced: no hours, no material, no design.
    quote: {
      design_billing: 'none',
      design_qty: 0,
      revisions_incl: 0,
      quantity: 1,
      material_id: null,
      printer_id: null,
      units_per_part: 0,
      print_hrs_part: 0,
      finishing_hrs: 0,
      rush: false,
      flat_each: 0,
      discount_pct: 0,
    },
  })
  await api.takeProjectIn(ctx.shop.id, saved.jobId, ctx.profile.id)
  return saved.jobId
}
