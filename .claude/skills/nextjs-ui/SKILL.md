---
name: nextjs-ui
description: Use when building or changing UI in the Next.js app — pages, components, forms, data fetching, or file uploads. Covers App Router conventions, where logic belongs, and the upload path.
---

# Next.js UI

## Structure

App Router. Server components by default.

Add `'use client'` only where you genuinely need interactivity, and push it as far down the tree as you can — a client boundary at the page level drags the whole subtree with it.

Data fetching happens in server components or route handlers. Components do not fetch their own data on mount when the server could have provided it.

## The UI does not know the rules

The database decides what is valid. The UI displays that decision.

Never re-implement a rule client-side "to give faster feedback." Two copies of a rule become two different rules, and the one users see will be the wrong one. If the UI needs to know whether something is valid, ask the database.

The one thing the UI *may* do is surface a rule's inputs so a human can check them — which is a display concern, not an enforcement one.

## Derived values come from one place

Streak, next target, confirmed count — these are defined once as a view and read from there. Do not recompute them in a component, and do not compute them twice in two different components. Two implementations of the same formula is a bug waiting for a mismatch.

## Uploads

Browser → R2 directly, via a presigned URL.

Never proxy a file upload through a route handler. Vercel caps serverless request bodies around 4.5 MB and phone photos routinely exceed that; it will work in testing and fail on a real photo.

Upload the **original file**. Never resize, re-encode, or canvas-process it client-side — that strips the EXIF capture time the ordering rule depends on. Display derivatives are generated server-side from the original.

iPhones shoot HEIC, which browsers cannot render. Transcode for display; keep the original as the evidence of record.

## Review screens

Show the reviewer everything they need to make the judgement, including values the database is already enforcing on. A rule checked against data no human ever sees cannot be caught when it's wrong — the capture time on the review screen is the concrete case.

## Secrets

The Supabase anon key is the only key that may reach the browser. Service role keys are server-side only, in environment variables, never in a component that could be rendered client-side.
