# Tickets research (3-minute pass, pattern research only)

Web search worked; page fetches were partial (Apple HIG and many app sites returned no body or nothing for Luma/DICE/Partiful/Eventbrite). Those references below are marked "(HIG/knowledge)" = from Apple guidance and shipping-app familiarity, not from an opened page. No artwork copied.

- Apple Wallet poster event ticket (iOS 26, `posterEventTicket`, semantic tags): one tall object, a single big event name/artwork, 3-4 facts below, code stays secondary on the back/bottom. https://developer.apple.com/documentation/walletpasses/creating-an-event-pass-using-semantic-tags (image: none opened)
- Apple Wallet classic eventTicket + HIG Wallet passes: header/primary/secondary/auxiliary field tiers, short labels, one background colour, code with a quiet zone on its own plate. https://developer.apple.com/design/human-interface-guidelines/wallet (HIG/knowledge)
- Ticketmaster Wallet guide: keep key visuals in a safe area away from header/footer, shorten long event names, entry info concise, links for arrival first. https://business.ticketmaster.co.uk/apple-wallet-passes-design-best-practices-and-fan-engagement-guide/ image: https://business.ticketmaster.co.uk/wp-content/uploads/2025/10/blog-hero_apple-wallet_100125.webp
- Flighty (boarding pass style, Apple Design Award 2023): departure-board hierarchy, one line per item, only essentials, state shown as a short status word; card peeks from the bottom. https://www.macstories.net/reviews/flighty-a-pro-level-ios-app-for-frequent-travelers/ (no image URL opened)
- InteractiveTicket (SwiftUI package, source not read): perforated ticket with vector notch cutouts and a dashed tear line, i.e. the ticket is one silhouette, not a card with a divider. https://swiftpackageindex.com/BalochCodes/InteractiveTicket
- Luma / Partiful / Apple Invites / DICE / Eventbrite (knowledge, not fetched): big title, 2-3 muted fact lines, one solid primary button pinned at the bottom, ticket QR shown full width on a white plate.

## What we take
1. The pass is one silhouette: stepped pixel notches at the seam, dashed tear line, sharp outer corners.
2. Upper "event" part: mono label, large tight conference name, 3-column mono fact row, pixel character + name + role.
3. Lower "admit" part: QR on a white plate, "DOOR TICKET" label and one state line.
4. Lime appears once per screen, on the primary action only; everything else is ink/muted.
5. Primary action depends on the day: Find my room when the conference is today, otherwise Directions; the rest are small icon+label glass buttons in one row, via `safeAreaInset`.
6. List rows are miniatures of the pass (same notches, vertical tear line, pixel character, TODAY / IN N DAYS / PAST tag), upcoming first, past dimmed.
7. 20pt margins, 8pt grid, three text sizes per screen, monospaced digits.

## What we avoid
- Borders on everything; glass on the pass; two lime elements; centred body copy; a QR that scrolls out of view; custom curves (notches are pixel steps only).
