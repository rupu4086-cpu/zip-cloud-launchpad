# Mobile website fixes
- [x] Fix narrow-screen layouts, profile styling, and touch targets.
- [x] Correct navigation and disruptive screen refreshes.
- [x] Verify phone layouts and available interactions; signed-in layouts checked with presentation fixtures only, real sign-in and payments not verified.

# Admin panel
- [x] Connect the uploaded panel to the existing Lovable Cloud data.
- [x] Allow admin access only for rupu4086@gmail.com and protect admin writes.
- [x] Add the admin entry point to the learner profile for authorized users.
- [ ] Verify course, lesson, payment settings, and access-control behavior.
  - Automated checks green (12 tests: admin panel, learner interactions, routing).
  - Still to verify live: admin role row for rupu4086@gmail.com in public.user_roles (one-time SQL check), password-reset email delivery, Realtime publication membership.