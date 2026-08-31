import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Is this string shaped like a plate? Asked of the database, answered by the
 * database.
 *
 * This exists so the form can give feedback as someone types without a second
 * copy of rule 1 living in the browser. `is_valid_plate()` is the same
 * function the `claims_plate_check` constraint calls, so the hint and the
 * verdict cannot disagree — widen the pattern in a migration and this follows
 * automatically.
 *
 * It is a hint, not a gate. Nothing here decides whether a claim is accepted;
 * the constraint does that at insert, as it did before this route existed.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  }

  const plate = request.nextUrl.searchParams.get('plate')
  if (plate === null) {
    return NextResponse.json({ error: 'plate is required' }, { status: 400 })
  }

  const { data, error } = await supabase.rpc('is_valid_plate', { p: plate })

  if (error) {
    // Never let a failure here look like a verdict. If the database cannot be
    // asked, the form shows no opinion rather than a wrong one.
    return NextResponse.json({ error: error.message }, { status: 502 })
  }

  return NextResponse.json({ valid: data === true })
}
