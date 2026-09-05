import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SubmitForm } from './submit-form'
import { AutoApproved } from './auto-approved'
import { formatTarget } from '@/lib/plate'

export default async function SubmitPage() {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) redirect('/login')

  // Derived values come from the view, which is their single definition.
  // Never recomputed here.
  const { data: state } = await supabase
    .from('v_player_state')
    .select(
      'display_name, next_target, confirmed_count, pending_count, auto_approved_count, first_rejected',
    )
    .eq('player_id', auth.user.id)
    .single()

  if (!state) {
    return (
      <main className="mx-auto max-w-md p-6">
        <p>No player record found for this account yet.</p>
      </main>
    )
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 p-6">
      <header>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold">
            Target plate: {formatTarget(state.next_target)}
          </h1>
          <Link
            href="/review"
            className="shrink-0 text-sm text-neutral-500 underline underline-offset-4"
          >
            Review
          </Link>
        </div>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {state.display_name} — {state.confirmed_count} confirmed ·{' '}
          {state.auto_approved_count} unobjected · {state.pending_count} pending
          {state.first_rejected !== null && (
            <> · rejected at {formatTarget(state.first_rejected)}</>
          )}
        </p>
      </header>

      <SubmitForm target={state.next_target} />

      <AutoApproved playerId={auth.user.id} />
    </main>
  )
}
