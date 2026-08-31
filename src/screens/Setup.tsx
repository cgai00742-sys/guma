/**
 * First-run setup.
 *
 * Everything that used to be seeded SQL for one shop on one island is asked
 * here instead. Nothing has a jurisdiction baked in: the tax is a label and a
 * number the shop supplies, the currency is theirs, and the rates start blank
 * rather than at someone else's numbers — a suggested figure in a placeholder
 * is a hint, a pre-filled input is a recommendation, and this tool has no
 * business recommending what another shop should charge.
 *
 * Cinematic register: this is a screen someone passes through exactly once.
 */
import { useMemo, useState, type FormEvent } from 'react'
import { makeMoney } from '../lib/pricing'
import { setupShop, type SetupPayload } from '../lib/data'

const STEPS = ['Your shop', 'Your rates', 'First machine'] as const

const CURRENCIES = [
  ['USD', 'en-US', 'US dollar'],
  ['CAD', 'en-CA', 'Canadian dollar'],
  ['EUR', 'de-DE', 'Euro'],
  ['GBP', 'en-GB', 'Pound sterling'],
  ['AUD', 'en-AU', 'Australian dollar'],
  ['NZD', 'en-NZ', 'New Zealand dollar'],
  ['JPY', 'ja-JP', 'Japanese yen'],
  ['SEK', 'sv-SE', 'Swedish krona'],
  ['PLN', 'pl-PL', 'Polish złoty'],
  ['BRL', 'pt-BR', 'Brazilian real'],
] as const

const STARTER_MATERIALS = [
  { name: 'PLA', kind: 'PLA', swatch: '#5A6B7C', unit: 'g' as const, perKg: '' },
  { name: 'PETG', kind: 'PETG', swatch: '#FF7A45', unit: 'g' as const, perKg: '' },
  { name: 'ABS / ASA', kind: 'ASA', swatch: '#C9CFD6', unit: 'g' as const, perKg: '' },
]

export default function Setup({ onDone, fullName }: { onDone: () => void; fullName: string }) {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // step 1 — the shop
  const [name, setName] = useState('')
  const [legalName, setLegalName] = useState('')
  const [address, setAddress] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [licenseNo, setLicenseNo] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [locale, setLocale] = useState('en-US')
  const [taxLabel, setTaxLabel] = useState('')
  const [taxPct, setTaxPct] = useState('')
  const [electricityRate, setElectricityRate] = useState('')

  // step 2 — the rates
  const [designHourly, setDesignHourly] = useState('')
  const [finishingHourly, setFinishingHourly] = useState('')
  const [minimumOrder, setMinimumOrder] = useState('')
  const [rushPct, setRushPct] = useState('35')
  const [markup, setMarkup] = useState('2')
  const [depositPct, setDepositPct] = useState('50')
  const [depositWaive, setDepositWaive] = useState('150')
  const [materials, setMaterials] = useState(STARTER_MATERIALS)

  // step 3 — the first machine
  const [pName, setPName] = useState('')
  const [pModel, setPModel] = useState('')
  const [pTech, setPTech] = useState('fdm')
  const [pRate, setPRate] = useState('')
  const [pWear, setPWear] = useState('')
  const [pWatts, setPWatts] = useState('')

  const { money } = useMemo(() => makeMoney(currency, locale), [currency, locale])
  const num = (v: string) => (v.trim() === '' ? 0 : Number(v))
  // Distinct from num(): blank means "not supplied," not zero. Zero would
  // falsely claim free electricity or a printer that draws no power at all,
  // which would silently turn off the costsIncomplete flag pricing.ts relies
  // on to say "this margin is an estimate" honestly.
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v))

  // Nothing on this screen blocks Continue. A shop without a name yet, or one
  // that isn't ready to say where it operates, still gets a working tool —
  // it just costs machine time as a break-even estimate until the numbers
  // that would make it exact (address-driven context, electricity rate) are
  // filled in. See pricing.ts's costsIncomplete.
  const canNext = true

  async function finish(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload: SetupPayload = {
        shop: {
          name: name.trim(),
          legal_name: legalName.trim(),
          address: address.trim(),
          email: email.trim(),
          phone: phone.trim(),
          license_no: licenseNo.trim(),
          currency,
          locale,
          tax_label: taxLabel.trim() || 'Tax',
          tax_pct: num(taxPct),
          electricity_rate_kwh: numOrNull(electricityRate),
          quote_valid_days: 30,
          lead_days: 10,
        },
        rates: {
          design_hourly: num(designHourly),
          finishing_hourly: num(finishingHourly),
          rush_pct: num(rushPct),
          minimum_order: num(minimumOrder),
          deposit_pct: num(depositPct),
          deposit_when: 'design',
          deposit_waive_below: num(depositWaive),
          material_markup: num(markup) || 2,
          revisions_incl: 2,
          revision_hourly: num(designHourly) || null,
        },
        printer: pName.trim()
          ? {
              name: pName.trim(),
              model: pModel.trim(),
              tech: pTech,
              rate_hourly: num(pRate),
              wear_hourly: num(pWear),
              watts: numOrNull(pWatts),
            }
          : null,
        materials: materials
          .filter((m) => m.name.trim() && num(m.perKg) > 0)
          .map((m) => ({
            name: m.name.trim(),
            kind: m.kind,
            swatch: m.swatch,
            unit: m.unit,
            // stored per gram; the shop thinks in per-kilo
            cost_per_unit: num(m.perKg) / 1000,
          })),
        fullName,
      }
      await setupShop(payload)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="home" style={{ maxWidth: 760, width: '100%', textAlign: 'left' }}>
        <div style={{ textAlign: 'center' }}>
          <img
            src="/brand/guma-mark.svg"
            alt=""
            width={46}
            height={42}
            style={{
              display: 'block',
              margin: '0 auto 10px',
              filter: 'drop-shadow(0 0 26px color-mix(in srgb, var(--biolum) 40%, transparent))',
            }}
          />
          <h2>Set up your shop</h2>
          <div className="sub">Three steps. Everything here is editable afterwards.</div>
        </div>

        <div className="stepper" style={{ justifyContent: 'center', marginTop: 18 }}>
          {STEPS.map((s, i) => (
            <span key={s} className={i === step ? 'step cur' : i < step ? 'step done' : 'step'}>
              <i />
              {s}
            </span>
          ))}
        </div>

        <form onSubmit={step === STEPS.length - 1 ? finish : (e) => { e.preventDefault(); setStep(step + 1) }}>
          {step === 0 && (
            <>
              <div className="fld" style={{ marginTop: 14 }}>
                <label className="lbl" htmlFor="w-name">Shop name</label>
                <input id="w-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Kōlea 3D" />
                <div className="hint">What clients call you. Appears on every quote.</div>
              </div>

              <div className="grid2" style={{ marginTop: 10 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="w-legal">Legal name</label>
                  <input id="w-legal" value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Kōlea 3D LLC" />
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-lic">Tax / business licence no.</label>
                  <input id="w-lic" value={licenseNo} onChange={(e) => setLicenseNo(e.target.value)} />
                </div>
              </div>

              <div className="fld" style={{ marginTop: 10 }}>
                <label className="lbl" htmlFor="w-addr">Address</label>
                <input id="w-addr" value={address} onChange={(e) => setAddress(e.target.value)} />
                <div className="hint">
                  Optional — leave it blank if you're not ready to say. It just means Guma can't connect your
                  machine costs to where you actually run them.
                </div>
              </div>

              <div className="grid2" style={{ marginTop: 10 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="w-email">Email on quotes</label>
                  <input id="w-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-phone">Phone</label>
                  <input id="w-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
              </div>

              <div className="grid3" style={{ marginTop: 10 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="w-cur">Currency</label>
                  <select
                    id="w-cur"
                    value={currency}
                    onChange={(e) => {
                      const hit = CURRENCIES.find((c) => c[0] === e.target.value)
                      setCurrency(e.target.value)
                      if (hit) setLocale(hit[1])
                    }}
                  >
                    {CURRENCIES.map(([code, , label]) => (
                      <option key={code} value={code}>{code} — {label}</option>
                    ))}
                  </select>
                  <div className="hint">Sample: {money(1234.5)}</div>
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-taxlabel">Tax name</label>
                  <input id="w-taxlabel" value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} placeholder="VAT · GST · Sales tax" />
                  <div className="hint">Printed on the quote exactly as typed.</div>
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-taxpct">Tax %</label>
                  <input id="w-taxpct" type="number" step="0.001" min="0" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} placeholder="0" />
                  <div className="hint">Three decimals allowed. 0 if you don't charge it.</div>
                </div>
              </div>

              <div className="fld" style={{ marginTop: 10 }}>
                <label className="lbl" htmlFor="w-kwh">Your electricity rate, $/kWh</label>
                <input
                  id="w-kwh"
                  type="number"
                  step="0.0001"
                  min="0"
                  value={electricityRate}
                  onChange={(e) => setElectricityRate(e.target.value)}
                  placeholder="from your utility bill"
                />
                <div className="hint">
                  Optional, but this is the one number location actually changes: power is often the biggest real
                  cost behind your machine-time rate, and it varies by utility, not by guesswork. Leave it blank and
                  Guma will still price every quote — it just can't tell you your real margin on machine time until
                  this and each printer's wattage (next step) are both on file. It'll say so rather than pretend.
                </div>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="notice" style={{ marginTop: 14 }}>
                <span>
                  <b>These are yours, not ours.</b> Guma ships no default rates on purpose — a number
                  pre-filled here would be a recommendation, and no tool knows what your hour is worth.
                  Every one of them is editable later, and a sent quote keeps the numbers it was priced with.
                </span>
              </div>

              <div className="grid2" style={{ marginTop: 12 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="w-design">Design / modelling per hour</label>
                  <input id="w-design" autoFocus type="number" min="0" value={designHourly} onChange={(e) => setDesignHourly(e.target.value)} />
                  <div className="hint">Usually the biggest line on a quote.</div>
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-finish">Finishing per hour</label>
                  <input id="w-finish" type="number" min="0" value={finishingHourly} onChange={(e) => setFinishingHourly(e.target.value)} />
                  <div className="hint">Support removal, sanding, wash and cure.</div>
                </div>
              </div>

              <div className="grid3" style={{ marginTop: 10 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="w-min">Shop minimum</label>
                  <input id="w-min" type="number" min="0" value={minimumOrder} onChange={(e) => setMinimumOrder(e.target.value)} />
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-rush">Rush surcharge %</label>
                  <input id="w-rush" type="number" min="0" value={rushPct} onChange={(e) => setRushPct(e.target.value)} />
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-markup">Material markup ×</label>
                  <input id="w-markup" type="number" step="0.1" min="1" value={markup} onChange={(e) => setMarkup(e.target.value)} />
                  <div className="hint">Sell = cost × this.</div>
                </div>
              </div>

              <div className="grid2" style={{ marginTop: 10 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="w-dep">Deposit %</label>
                  <input id="w-dep" type="number" min="0" max="100" value={depositPct} onChange={(e) => setDepositPct(e.target.value)} />
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-depw">Waive deposit below</label>
                  <input id="w-depw" type="number" min="0" value={depositWaive} onChange={(e) => setDepositWaive(e.target.value)} />
                  <div className="hint">Chasing a small deposit costs more than it collects.</div>
                </div>
              </div>

              <div className="pane" style={{ marginTop: 14, marginBottom: 0 }}>
                <h3>What you pay for filament<span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--txt-3)', textTransform: 'none', letterSpacing: 0 }}>per kg · leave blank to skip</span></h3>
                {materials.map((m, i) => (
                  <div key={m.name} className="grid2" style={{ marginTop: i ? 8 : 0, alignItems: 'end' }}>
                    <div className="fld">
                      <label className="lbl" htmlFor={`w-m${i}`}>{m.name}</label>
                      <input
                        id={`w-m${i}`}
                        type="number"
                        min="0"
                        value={m.perKg}
                        onChange={(e) =>
                          setMaterials((ms) => ms.map((x, j) => (j === i ? { ...x, perKg: e.target.value } : x)))
                        }
                      />
                    </div>
                    <div className="hint" style={{ paddingBottom: 8 }}>
                      {num(m.perKg) > 0
                        ? `sells at ${money((num(m.perKg) * (num(markup) || 2)))} / kg`
                        : 'not stocked'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid2" style={{ marginTop: 14 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="w-pname">What you call it</label>
                  <input id="w-pname" autoFocus value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Bay 1" />
                  <div className="hint">Leave blank to add machines later.</div>
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-pmodel">Make and model</label>
                  <input id="w-pmodel" value={pModel} onChange={(e) => setPModel(e.target.value)} placeholder="Prusa Core One" />
                </div>
              </div>

              <div className="grid3" style={{ marginTop: 10 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="w-ptech">Technology</label>
                  <select id="w-ptech" value={pTech} onChange={(e) => setPTech(e.target.value)}>
                    <option value="fdm">FDM — filament</option>
                    <option value="resin">Resin — MSLA / SLA</option>
                    <option value="composite">Composite — continuous fibre</option>
                    <option value="sls">SLS — powder</option>
                  </select>
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-prate">Rate per hour</label>
                  <input id="w-prate" type="number" min="0" value={pRate} onChange={(e) => setPRate(e.target.value)} />
                  <div className="hint">Power, space, your attention.</div>
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="w-pwear">Wear per hour</label>
                  <input id="w-pwear" type="number" min="0" value={pWear} onChange={(e) => setPWear(e.target.value)} />
                  <div className="hint">Machine price ÷ lifetime hours is a fair start.</div>
                </div>
              </div>

              <div className="fld" style={{ marginTop: 10, maxWidth: 260 }}>
                <label className="lbl" htmlFor="w-pwatts">Power draw while printing, watts</label>
                <input id="w-pwatts" type="number" min="0" value={pWatts} onChange={(e) => setPWatts(e.target.value)} placeholder="from the spec sheet" />
                <div className="hint">
                  Optional. Paired with your electricity rate above, this is what turns "machine time" from a guess
                  into an actual cost — without it Guma prices the job the same either way, it just can't show you
                  the real margin on it.
                </div>
              </div>

              <div className="hint" style={{ marginTop: 12 }}>
                Guessing low on wear is how a shop finds out it has been printing at cost.
              </div>
            </>
          )}

          {error && (
            <div className="alert" style={{ marginTop: 12 }}>
              <span>{error}</span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 18, alignItems: 'center' }}>
            {step > 0 && (
              <button type="button" className="btn" onClick={() => setStep(step - 1)} disabled={busy}>
                Back
              </button>
            )}
            <button type="submit" className="btn primary" disabled={!canNext || busy} style={{ marginLeft: 'auto' }}>
              {busy ? 'Creating…' : step === STEPS.length - 1 ? 'Create my shop' : 'Continue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
