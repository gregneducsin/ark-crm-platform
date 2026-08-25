# Staff-Review Texting Guide

**Scope:** for whoever picks up a conversation once Alexis (sales) or Sophie (support)
escalates it — the "This conversation needs staff attention" banner in the
dashboard. Not a script to read verbatim — a boundary guide: what's safe to
say in your own words, and what must never be said by non-clinical staff, no
matter how the question is phrased.

This isn't arbitrary — it mirrors the same rules already enforced in code for
Alexis and Sophie (see `apps/api/src/lib/messaging/safety.ts` and
`apps/api/src/lib/support/safety.ts`), so staff replies stay consistent with
what the bots are already held to.

## Why a conversation lands here

1. **Opt-out language** (STOP, unsubscribe, "leave me alone," etc.) — legal
   requirement to stop texting entirely
2. **Emergency/crisis language** (emergency, crisis, suicide, self-harm, "911")
3. **Prescription-specific questions** — dose, timing/administration, side
   effects, diagnosis, drug interactions, "why was I prescribed this,"
   refill-early requests
4. **Legal threats** (attorney, lawsuit, "I will sue")
5. Anything the AI just wasn't confident enough to answer safely on its own

## The one rule underneath all of it

Anything requiring individualized clinical judgment about *this patient's*
treatment — dosing, timing, side effects, interactions, changing a
prescription — has to come from a licensed provider. Not from support or
sales staff, no matter how simple or "common sense" the question feels.

**Worked example — a patient whose prescription was just written (not yet
shipped) asks "when should I start taking this, at night or morning?":**

- Don't answer it yourself, even "typically at night" — that's still
  individualized dosing guidance.
- Since the medication hasn't shipped yet, there's no label to point to
  either. The right reply is: *"Once your medication arrives, the exact
  dosing and timing will be printed right on the pharmacy label — that's
  what to follow. If anything's unclear once you have it in hand, let us
  know and we'll get our provider to clarify."*

## Always safe to say

- **Order/fulfillment status** — prescription written, shipped, tracking
  number. Factual, not clinical.
- **Redirect to the label** (once the patient actually has the bottle in
  hand): *"Your prescription bottle has the exact dosing and timing
  instructions from the provider/pharmacy printed right on the label —
  please follow what's printed there."* This is safe because you're
  pointing to the authoritative, provider-approved source, not stating
  dosing from memory or judgment. Only use this once the medication's
  actually been dispensed — if the patient doesn't have it yet, or says the
  label's missing/unclear/damaged, or asks something the label wouldn't
  cover (e.g. "can I take it with X"), that's still a provider-routing
  situation, not something to paper over.
- **Approved pricing only:**
  - Semaglutide: $120/mo (1-mo) · $80/mo, $240 total (3-mo) · $78/mo, $468
    total (6-mo)
  - Tirzepatide: $165/mo (1-mo) · $150/mo, $450 total (3-mo) · $147/mo, $882
    total (6-mo)
  - $20 off first month, new customers, auto-applied, doesn't stack with
    other promos
  - Never quote a different number or negotiate over text.
- **Portal:** `https://patient.tryark.com/login` — this exact link only
- **If legitimacy comes up:** *"We're a licensed telehealth provider, your
  info is handled under HIPAA, and a real provider reviews everything
  before anything moves forward."* Reviews, if asked:
  `consumeraffairs.com/health/ark-health.html`,
  `consumersverified.com/ark-health`, write-a-review at
  `consumeraffairs.com/review/write/?brand_id=27277`
- General process/eligibility/cancellation-policy explanations, in your own
  words

## Never say, regardless of context

- Anything about dosage, timing, titration, or "how much/how often" for a
  specific patient (beyond pointing them to their own label, once they have
  it)
- Side effects — even generic ones — that's still clinical guidance from a
  non-clinician
- Diagnosing or speculating about why someone was prescribed what they were
  prescribed
- Confirming/denying drug interactions or allergy safety
- Claiming staff is available "24/7" or "monitored around the clock" — don't
  imply availability that isn't real
- Outcome guarantees ("you'll definitely lose X lbs")
- Any price/discount that isn't one of the approved figures above
- Any URL other than the four listed above
- Arguing or admitting fault against a legal threat — acknowledge, then
  escalate internally, don't negotiate over text

## Opt-outs and emergencies get handled differently, not just answered

- **Opt-out:** legally must stop — no further texts of any kind. (Known
  gap: nothing in the system currently tracks this automatically, so right
  now it's entirely on whoever sees it to make sure it's honored.)
- **Emergency/crisis:** don't text-triage this. Point to 911 / the 988
  Suicide & Crisis Lifeline and get a real person on the phone if at all
  possible.

## Worth deciding as a team

"Mark reviewed" only clears the dashboard flag — there's no reply box wired
to it yet, so your actual reply still goes out through whatever channel
you're using today. Also, staff-review handoffs currently land silently in
the dashboard with no push notification (Slack/email/etc.) — that's a
known, unbuilt piece (see the `TODO(staff-review-workflow)` comment in
`apps/api/src/lib/messaging/objection-handling.ts`), so this only works if
someone's actively watching the dashboard.
