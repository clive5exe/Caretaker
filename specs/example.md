---
title: Checkout
status: accepted
updated: 2026-08-30
---

```spec
hosts:   api.stripe.com
governs: src/lib/pricing*, src/app/api/checkout/**
```

# Checkout

The buyer pays the face value plus one fee, and that is the whole sum.

Two fields, because everything else already exists. `devcontainer.json` carries
the image, the toolchain features and the resource limits, and it has real
adoption behind it. What it has no property for is network egress, and nothing
anywhere maps a path to the document that governs it. Those are the two here.

`governs` is what makes drift detectable: if a file under those globs changes
and this spec does not, the task cannot close.
