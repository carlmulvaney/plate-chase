---
name: ui-stability
description: Use when adding or changing anything that renders conditionally, shows a user-supplied image, or sits above a button. Covers keeping the layout still so controls do not move under the cursor.
---

# UI stability

Nothing on screen may move because of something that arrived after the first
paint. Not the buttons, not the text above them, not the page as a whole.

This is not polish. The submit and review screens both end in a pair of buttons
where a misclick is expensive — a wrong verdict costs someone their streak —
and a control that shifts as an image loads is a control that gets clicked by
accident.

## The four ways it has actually gone wrong here

Every layout bug on this project has been one of these.

### 1. Conditional text with nothing holding its place

A hint that renders only once there is something to say pushes everything below
it down the moment it appears.

Render the element always and let it be empty, with a minimum height:

```tsx
<p aria-live="polite" className={`min-h-4 text-xs ${tone}`}>
  {check === 'bad' && 'Invalid plate format (e.g. 1ABC234)'}
  {check === 'ok' && 'Valid plate format'}
</p>
```

Reserve enough height for the longest wording, not the shortest. If the longest
wraps to two lines on a narrow screen, reserve two.

### 2. A row that disappears instead of saying "none"

Omitting a row when there is no value to show makes the block a line shorter in
that state. Say "none" in the row rather than removing it — it reads the same
and the height does not change.

### 3. An image sizing its own container

Photos arrive portrait and landscape, at any resolution, after the layout has
already painted. Give the container a fixed height and contain the image within
it:

```tsx
<div className="flex h-80 w-full items-center justify-center overflow-hidden">
  <img className="max-h-full max-w-full object-contain" ... />
</div>
```

### 4. The scrollbar

A page that grows tall enough to scroll loses the scrollbar's width from the
viewport the moment it appears, and every centred layout jumps sideways with
it. `scrollbar-gutter: stable` is set on `html` in `globals.css`; leave it
there.

Centred containers also carry `w-full` alongside `max-w-*`, so the maximum caps
the width rather than the content deciding it.

## Checking it

Switch between two states that differ — a claim with a predecessor and one
without, a portrait photo and a landscape one, a valid plate and an invalid one
— and watch the buttons. If they move at all, something above them changes size.
