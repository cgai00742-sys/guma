/**
 * Guma's tools, as an MCP server exposes them.
 *
 * WHY THIS SHAPE
 *
 * Guma has one rule: the AI reads the mess, the math stays deterministic. The
 * honest way to hold that line is not to promise it in a prompt — it is to
 * make it structurally impossible. So Guma does not call a model. A model
 * calls Guma.
 *
 * A shop points Claude, or Cursor, or anything else that speaks MCP, at the
 * `guma-mcp` command. The model can then read the shop's rates and projects
 * and ASK GUMA to price something — `price_quote` runs the same
 * `src/lib/pricing.ts` the app runs, against the same rate card, and hands
 * back the same numbers. The model supplies hours and grams. It never
 * supplies a price, because there is no tool that accepts one.
 *
 * That also means Guma ships no API key field, no provider list, no prompt
 * templates, and no GPU requirement. It works with whatever model the shop
 * already pays for, including none.
 *
 * WHAT IS DELIBERATELY MISSING
 *
 * Every one of these is a refusal, not an oversight:
 *
 *   - recording, editing or refunding a payment
 *   - setting a quote to sent / accepted / declined
 *   - changing any rate, markup, deposit percentage or minimum
 *   - taking a draft in (that is the moment a shop agrees to do work)
 *   - deleting anything at all
 *
 * The first three are money. The fourth is a commercial commitment. The fifth
 * is irreversible. A person does those in the app, having looked at them.
 * `writeRefusals` below is the list, and it is exported so a test can prove
 * no tool quietly grows the ability later.
 */
import * as local from '../data.local'
import { priceQuote, makeMoney, type QuoteInputs } from '../pricing'
import {
  toRateSet,
  type JobPhase,
  type RunOutcome,
  type ShopContext,
  type WorkKind,
} from '../data.types'
import { GATES, PHASE_LABEL, flagsFor, gateStatus, nextPhase } from '../gates'
import { todayISO } from '../dates'

export interface ToolDef {
  name: string
  /** Written for a model to read: what it does, and what it will not do. */
  description: string
  inputSchema: Record<string, unknown>
  /** True when calling it changes the database. Drives the read-only mode. */
  writes?: boolean
  handler: (args: Record<string, any>, ctx: ShopContext) => Promise<unknown>
}

/**
 * The capabilities no tool has, each with the reason. Exported so
 * tools.test.ts can assert the surface never grows one by accident — a
 * boundary that is only described in a comment is a boundary that erodes.
 */
export const writeRefusals = [
  { what: 'record, edit or refund a payment', why: 'money' },
  { what: 'set a quote to sent, accepted or declined', why: 'money' },
  { what: 'change a rate, markup, deposit or minimum', why: 'money' },
  { what: 'take a draft in as a real project', why: 'agreeing to do work' },
  { what: 'delete a project, payment, run, part or work entry', why: 'irreversible' },
] as const

const str = (d: string) => ({ type: 'string', description: d })
const num = (d: string) => ({ type: 'number', description: d })
const bool = (d: string) => ({ type: 'boolean', description: d })
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
})

/** Money as the shop writes it, so a model quoting a figure back to a person
 *  quotes it in their currency rather than reformatting it into someone
 *  else's. */
function fmt(ctx: ShopContext) {
  const rates = toRateSet(ctx.rateCard, ctx.shop)
  return makeMoney(rates.currency, rates.locale).money
}

function quoteInputsFrom(a: Record<string, any>): QuoteInputs {
  return {
    assetOrigin: a.asset_origin ?? 'model',
    designBilling: a.design_billing ?? 'hourly',
    designQty: Number(a.design_hours ?? 0),
    revisions: Number(a.revisions ?? 2),
    quantity: Number(a.quantity ?? 1),
    unitsPerPart: Number(a.material_per_part ?? 0),
    printHrsPerPart: Number(a.print_hours_per_part ?? 0),
    finishingHrs: Number(a.finishing_hours ?? 0),
    rush: Boolean(a.rush ?? false),
    flatEach: Number(a.flat_each ?? 0),
    discountPct: Number(a.discount_pct ?? 0),
  }
}

const QUOTE_PROPS = {
  asset_origin: {
    type: 'string',
    enum: ['model', 'fix', 'ready'],
    description:
      "'model' = you build it from nothing (most jobs, biggest design line). 'fix' = the client sent a file that will not print as-is. 'ready' = print-ready, no design line.",
  },
  design_billing: { type: 'string', enum: ['hourly', 'flat', 'none'] },
  design_hours: num('Design and modelling hours. Ignored when asset_origin is "ready".'),
  revisions: num('Revision rounds included.'),
  quantity: num('How many pieces.'),
  material_id: str('Material id from guma_shop. Omit to leave the material line unpriced.'),
  printer_id: str('Printer id from guma_shop.'),
  material_per_part: num('Grams (or mL for resin) of material per single piece.'),
  print_hours_per_part: num('Machine hours per single piece.'),
  finishing_hours: num('Total post-processing hours across the whole job.'),
  rush: bool('Applies the shop’s rush surcharge.'),
  flat_each: num('An agreed price per piece. Replaces the material/machine lines entirely.'),
  discount_pct: num('Percentage off, applied after rush and before tax.'),
}

export function buildTools(): ToolDef[] {
  return [
    {
      name: 'guma_shop',
      description:
        'The shop itself: its name, currency, tax, rate card, materials (with ids and cost per unit) and printers (with ids, hourly rate and wear). Read this first — the ids here are what every other tool expects, and the rates here are the only rates that exist. Never invent a rate that is not in this response.',
      inputSchema: obj({}),
      handler: async (_a, ctx) => ({
        shop: {
          name: ctx.shop.name,
          legal_name: ctx.shop.legal_name,
          currency: ctx.shop.currency,
          locale: ctx.shop.locale,
          tax_label: ctx.shop.tax_label,
          tax_pct: ctx.shop.tax_pct,
          quote_valid_days: ctx.shop.quote_valid_days,
          lead_days: ctx.shop.lead_days,
        },
        rates: toRateSet(ctx.rateCard, ctx.shop),
        materials: ctx.materials,
        printers: ctx.printers,
        today: todayISO(),
      }),
    },

    {
      name: 'guma_price_quote',
      description:
        'Price a job using the shop’s own rate card and Guma’s pricing engine, and return every line with the arithmetic behind it. This is the ONLY way to get a number out of Guma, and it writes nothing. Do not compute a price yourself and do not round, adjust or "sanity check" what comes back — the figures here are the ones the shop stands behind, including the minimum-order floor and the deposit rule.',
      inputSchema: obj(QUOTE_PROPS),
      handler: async (a, ctx) => {
        const rates = toRateSet(ctx.rateCard, ctx.shop)
        const material = a.material_id
          ? (ctx.materials.find((m) => m.id === a.material_id) ?? null)
          : null
        const printer = a.printer_id
          ? (ctx.printers.find((p) => p.id === a.printer_id) ?? null)
          : null
        const q = priceQuote(quoteInputsFrom(a), rates, material, printer)
        const money = fmt(ctx)
        return {
          lines: q.lines.map((l) => ({ label: l.label, basis: l.basis, amount: l.amount, shown: money(l.amount) })),
          adjustments: q.adjustments.map((x) => ({ label: x.label, sign: x.sign, amount: x.amount })),
          subtotal: q.subtotal,
          minimum_applied: q.minimumApplied,
          tax: q.tax,
          total: q.total,
          total_shown: money(q.total),
          deposit: q.deposit,
          deposit_waived: q.depositWaived,
          balance: q.balance,
          per_unit: q.perUnit,
          costs_incomplete: q.costsIncomplete,
          note: q.costsIncomplete
            ? 'Margin on this job is an estimate: the printer wattage or the shop’s electricity rate is not on file, so machine time is costed at break-even. Say so if you report a margin.'
            : null,
        }
      },
    },

    {
      name: 'guma_list_projects',
      description:
        'Every project on the board: stage, client, what it was quoted at, what is still owed, when it is due, and its flags. Flags are derived live and each carries the reason with real numbers in it — quote them rather than paraphrasing.',
      inputSchema: obj({
        include_drafts: bool('Include saved drafts that have not been taken in. Default false.'),
        phase: str('Only this stage: intake, design, approval, scheduled, build, review, delivered.'),
      }),
      handler: async (a, ctx) => {
        const rows = await local.listJobs(ctx.shop.id)
        return rows
          .filter((r: any) => (a.include_drafts ? true : r.takenInAt ?? r.taken_in_at ?? true))
          .filter((r: any) => (a.phase ? r.phase === a.phase : true))
          .map((r: any) => ({ ...r, stage: PHASE_LABEL[r.phase as keyof typeof PHASE_LABEL] ?? r.phase }))
      },
    },

    {
      name: 'guma_project',
      description:
        'Everything about one project: the brief, the client, the quote, the current stage and its gate (which items are cleared, which are outstanding, and what clears each one), the flags, the payments, and what it has actually consumed so far.',
      inputSchema: obj({ job_id: str('Project id from guma_list_projects.') }, ['job_id']),
      handler: async (a, ctx) => {
        const d = await local.loadProjectDetail(ctx.shop.id, String(a.job_id))
        const gate = gateStatus(d.phase, d.gates[d.phase] ?? {}, d.facts)
        return {
          ...d,
          stage: PHASE_LABEL[d.phase],
          gate: {
            cleared: gate.done,
            total: gate.total,
            blocked: gate.blocked,
            reason: gate.reason,
            next_stage: gate.next ? PHASE_LABEL[gate.next] : null,
            items: gate.items.map((i) => ({
              key: i.key,
              label: i.label,
              why: i.why,
              satisfied: i.checked,
              automatic: i.automatic,
              clears_by: i.fix ?? null,
            })),
          },
          flags: flagsFor(d.facts),
        }
      },
    },

    {
      name: 'guma_list_clients',
      description:
        'The client list with what each one is worth: type, number of projects, active work, quoted value and what they still owe. Quoted counts sent and accepted quotes only — a draft is a number typed to oneself.',
      inputSchema: obj({}),
      handler: async (_a, ctx) => local.listClients(ctx.shop.id),
    },

    {
      name: 'guma_create_draft',
      description:
        'Create a DRAFT project from an enquiry, priced with guma_price_quote’s own engine. This is the main thing to do with a rambling customer email: turn it into a filled-in, correctly priced draft the shop can look at. The draft is NOT on the pipeline board and is NOT work anyone has agreed to — a person takes it in from the project page. There is no tool to take it in, on purpose.',
      inputSchema: obj(
        {
          client_name: str('The client. An existing client with this name is reused.'),
          contact: str('Person’s name at the client.'),
          email: str(''),
          phone: str(''),
          source: str('How they found the shop.'),
          title: str('Short project title.'),
          brief: str(
            'Two or three sentences in the shop’s words: what they want, in what material, to what tolerance. The intake gate reads this, so write it properly rather than pasting the email.',
          ),
          needed_by: str('YYYY-MM-DD, if they gave one.'),
          ...QUOTE_PROPS,
        },
        ['client_name', 'title'],
      ),
      writes: true,
      handler: async (a, ctx) => {
        const ref = await local.nextJobRef(ctx.shop.id)
        const saved = await local.saveQuote({
          shopId: ctx.shop.id,
          ref,
          client: {
            name: String(a.client_name).trim(),
            contact: a.contact ?? '',
            email: a.email ?? '',
            phone: a.phone ?? '',
            source: a.source ?? '',
          },
          job: {
            title: String(a.title).trim(),
            brief: a.brief ?? '',
            neededBy: a.needed_by ?? null,
            assetOrigin: a.asset_origin ?? 'model',
          },
          quote: {
            design_billing: a.asset_origin === 'ready' ? 'none' : (a.design_billing ?? 'hourly'),
            design_qty: Number(a.design_hours ?? 0),
            revisions_incl: Number(a.revisions ?? ctx.rateCard.revisions_incl),
            quantity: Number(a.quantity ?? 1),
            material_id: a.material_id ?? null,
            printer_id: a.printer_id ?? null,
            units_per_part: Number(a.material_per_part ?? 0),
            print_hrs_part: Number(a.print_hours_per_part ?? 0),
            finishing_hrs: Number(a.finishing_hours ?? 0),
            rush: Boolean(a.rush ?? false),
            flat_each: Number(a.flat_each ?? 0),
            discount_pct: Number(a.discount_pct ?? 0),
          },
        })
        return {
          job_id: saved.jobId,
          ref,
          state: 'draft',
          next: 'A person opens this project in Guma and clicks "Take it into Intake" if the shop wants the work. Nothing is committed until they do.',
        }
      },
    },

    {
      name: 'guma_add_note',
      description:
        'Add a note to a project’s activity log. Use it to record what a client said, what was agreed on a call, or why something is waiting — the log is where the next person finds out.',
      inputSchema: obj({ job_id: str(''), note: str('') }, ['job_id', 'note']),
      writes: true,
      handler: async (a, ctx) => {
        await local.addProjectNote(String(a.job_id), ctx.profile.id, String(a.note))
        return { ok: true }
      },
    },

    {
      name: 'guma_tick_gate',
      description:
        'Tick a MANUAL gate item, with a note. Automatic items — a quote priced, a deposit collected, a part off the machine — are refused: they are cleared by doing the thing, and the whole point is that they cannot be talked past. guma_project lists which is which and what clears each one.',
      inputSchema: obj(
        { job_id: str(''), phase: str(''), item_key: str('The item key from guma_project.'), note: str('') },
        ['job_id', 'phase', 'item_key'],
      ),
      writes: true,
      handler: async (a, ctx) => {
        const phase = String(a.phase) as JobPhase
        const item = (GATES[phase] ?? []).find((i) => i.key === a.item_key)
        if (!item) throw new Error(`No gate item "${a.item_key}" on stage "${a.phase}".`)
        if (item.auto) {
          throw new Error(
            `"${item.label}" is automatic — it reads the project's own rows and cannot be ticked. ${item.fix ?? ''}`.trim(),
          )
        }
        if (item.needsNote && !String(a.note ?? '').trim()) {
          throw new Error(`"${item.label}" needs a note saying what was actually done.`)
        }
        await local.setGateItem(
          ctx.shop.id,
          String(a.job_id),
          ctx.profile.id,
          phase,
          item.key,
          true,
          String(a.note ?? '') || null,
        )
        return { ok: true }
      },
    },

    {
      name: 'guma_advance_stage',
      description:
        'Move a project to the next stage. Refuses, with the reason, if the current stage’s gate is not clear — the gate is the point, and a stage moved past an unmet gate is a project that will surprise someone later.',
      inputSchema: obj({ job_id: str('') }, ['job_id']),
      writes: true,
      handler: async (a, ctx) => {
        const d = await local.loadProjectDetail(ctx.shop.id, String(a.job_id))
        if (!d.facts.takenInAt) {
          throw new Error(
            'This is still a draft. A person takes it in from the project page; there is no tool for that.',
          )
        }
        const gate = gateStatus(d.phase, d.gates[d.phase] ?? {}, d.facts)
        if (gate.blocked) throw new Error(`Cannot advance: ${gate.reason}`)
        const next = nextPhase(d.phase)
        if (!next) throw new Error('Already at the last stage.')
        await local.updateJobPhase(ctx.shop.id, String(a.job_id), ctx.profile.id, next)
        return { ok: true, phase: next, stage: PHASE_LABEL[next] }
      },
    },

    {
      name: 'guma_log_run',
      description:
        'Record a build run: which printer, which material, how many units of material it drew, how many hours it took, and whether it came off well. A failed or cancelled run needs a reason, and is counted as the cost it is — it burned material and machine time.',
      inputSchema: obj(
        {
          job_id: str(''),
          printer_id: str(''),
          material_id: str(''),
          units: num('Grams or mL consumed.'),
          hours: num(''),
          outcome: { type: 'string', enum: ['success', 'failed', 'cancelled'] },
          note: str('Required when the outcome is not "success" — say what went wrong.'),
          when: str('YYYY-MM-DD. Defaults to today.'),
        },
        ['job_id', 'printer_id', 'units', 'hours'],
      ),
      writes: true,
      handler: async (a, ctx) => {
        const outcome = (a.outcome ?? 'success') as RunOutcome
        await local.recordPrintRun(ctx.shop.id, String(a.job_id), ctx.profile.id, {
          printerId: String(a.printer_id),
          materialId: a.material_id ?? null,
          unitsUsed: Number(a.units),
          hours: Number(a.hours),
          outcome,
          failureReason: outcome === 'success' ? null : (a.note ?? null),
          note: a.note ?? null,
          startedAt: a.when ?? todayISO(),
        })
        return { ok: true }
      },
    },

    {
      name: 'guma_log_work',
      description:
        'Log your own hours against a project — design, finishing, admin. This is what makes "what did we actually earn" a real number rather than a guess, because the margin counts your time at the rate you charge for it.',
      inputSchema: obj(
        { job_id: str(''), kind: str('design | finishing | admin | other'), hours: num(''), note: str(''), when: str('YYYY-MM-DD') },
        ['job_id', 'kind', 'hours'],
      ),
      writes: true,
      handler: async (a, ctx) => {
        await local.logWork(ctx.shop.id, String(a.job_id), ctx.profile.id, {
          kind: a.kind as WorkKind,
          hours: Number(a.hours),
          workedOn: a.when ?? todayISO(),
          note: a.note ?? null,
        })
        return { ok: true }
      },
    },
  ]
}

/** Read-only mode drops every writing tool rather than leaving them listed
 *  and failing — a tool a model can see is a tool it will try. */
export function toolsFor(mode: 'read' | 'write'): ToolDef[] {
  const all = buildTools()
  return mode === 'write' ? all : all.filter((t) => !t.writes)
}
