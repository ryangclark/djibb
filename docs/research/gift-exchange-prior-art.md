# Gift-exchange prior art: draws, exclusions and secrecy

Research for [#81](https://github.com/ryangclark/djibb/issues/81), feeding the Secret Santa client map ([#76](https://github.com/ryangclark/djibb/issues/76)). Surveyed 2026-10-11.

Question: how do the established gift-exchange and wishlist products handle draws, exclusions, organizer secrecy, purchased state, multi-group wishlists, hidden suggestions, free-for-all versus assigned modes, identity reveal, and sign-in friction?

## How to read the sourcing

Every claim carries a source link and one of three marks:

- **[F]** Fetched and read from the vendor's own page during this survey.
- **[S]** The vendor's own page, but read only through a search-engine excerpt. All of `help.giftster.com` and `giftster.com`, and `giftful.com/faqs`, refused direct fetches (Cloudflare 403 or an empty page), so every Giftster and Giftful claim is [S]. Treat the wording as close but not verified verbatim.
- **[2]** Secondary source (review site, app-store review, competitor page). Used only for complaints.

"Not found" means the vendor's docs did not say, not that the feature is absent.

Products covered: Elfster, DrawNames, Giftster, Secret Santa Organizer, Giftful, Wishpicks. Elfster, DrawNames and Giftster are the three that combine a draw with wishlists and so matter most. Secret Santa Organizer is a draw-only tool. Giftful and Wishpicks are wishlist-only tools with no draw.

## Summary

**Common patterns**

1. The draw is random, never assigns a person to themselves, and takes organizer-set exclusions. Exclusions are one-directional in all three main products: a couple needs two entries.
2. Avoiding last year's pairing is automatic, and works only when the new exchange is created from the old one inside the product.
3. The giftee never sees purchased state on their own list. Other givers do. This is the default everywhere.
4. Purchase marking is manual. Buying through a store link never marks the item.
5. Multi-quantity wishes are a counter: each giver marks one unit, and the item stays available until the count is used up. Nobody offers an explicit "unlimited" wish.
6. Nobody has a built-in "reveal your Secret Santa" moment. Reveal is left to the in-person exchange.
7. Latecomers and dropouts are handled by patching the affected pairings, not by redrawing.

**Where products genuinely differ**

1. **Can the organizer peek at the draw?** Elfster: yes, organizers and assistants can open every pairing, including who drew them. Giftster and DrawNames: no, the organizer is kept out. Secret Santa Organizer: yes, behind an opt-in button.
2. **Is the buyer's name shown to other givers?** Elfster: never. Giftster: yes, behind a click-to-reveal label, switched off while a draw is running. Wishpicks: depends on a per-list setting.
3. **One state or two?** Elfster has "purchased" only. Giftster has "reserved" then "purchased". DrawNames and Wishpicks have "reserved" as the main state.
4. **Hidden suggestions.** Only Giftster has them, and it names the suggester.
5. **Group-first or exchange-first.** Giftster is a standing family group where everyone shops for everyone, and a draw is optional on top. Elfster is exchange-first with account-level wishlists. DrawNames offers both as separate group types.
6. **Accounts.** Elfster and Giftster require an account per person, with a parent-managed sub-account for children. DrawNames and Secret Santa Organizer run on emailed personal links with no account.

**No product documents purchased state following one item across several groups as a designed feature.** Where it works (Giftster, Elfster) it is a side effect of the wishlist belonging to the account, not the group. None documents choosing per group which items are eligible; the closest is Elfster's per-wishlist visibility by exchange. The djibb plan (one wishlist feeding several groups, per-group item eligibility, taken-ness shared) has no direct precedent in these docs.

## 1. The draw and its constraints

### Elfster

- Names are drawn automatically on a scheduled draw date, or the organizer turns automatic drawing off and draws by hand with "Draw Names Early". Anyone who has not RSVP'd by the draw is left out. [F] <https://help.elfster.com/en/articles/11487531-how-are-names-drawn>
- Draw Restrictions: the organizer picks a participant and ticks the names they must not draw. "Restrictions are unique to each person", so a couple needs one each way. "Only the Organizer and Assistants can see the Draw Restrictions." Restrictions carry over to future exchanges with the same group. [F] <https://help.elfster.com/en/articles/11475726-how-do-i-prevent-participants-from-drawing-someone-they-shouldn-t>
- Avoid last year: automatic when the exchange is created from a previous one. The system avoids repeats until options run out, and these implicit exclusions do not appear in the restrictions list. [F] same article. "You shouldn't draw the same person twice in a row", subject to group size and restrictions; deleting a past exchange deletes its draw history. [F] <https://help.elfster.com/en/articles/11500567-will-people-draw-the-same-person-they-drew-last-time>
- Redraw: "Undo Everyone's Draw", all or nothing. "Elfster is unable to retrieve or restore the previous draw." Whether participants are notified is not stated. [F] <https://help.elfster.com/en/articles/11500493-how-do-i-redo-the-draw-for-a-gift-exchange>
- Latecomers: no redraw needed. Several latecomers are assigned among themselves. A single latecomer is spliced into the chain: the organizer picks an existing giver, who now gives to the newcomer, and the newcomer inherits that giver's old recipient. [F] <https://help.elfster.com/en/articles/11500520-how-do-i-add-someone-after-names-have-been-drawn>
- Full manual assignment (organizer chooses every pairing): not found. The latecomer splice is the only hand-assignment documented.
- No self-draw: not stated in the help centre. Unconfirmed, though implied by the product.

### DrawNames

- "No one draws their own name." [F] <https://www.drawnames.com/how-to-draw-names>
- Exclusions: several per person, available from 4 members up. For partners, "make sure you set that for both names". Hidden from the group by default ("exclusions are only visible to the organizer"); the organizer can make them visible. Editable later only while at least 4 members have not yet drawn. [F] <https://www.drawnames.com/features/set-exclusions>
- Avoid last year: "drawnames remembers previous draws and automatically excludes repeat matches when you reuse celebrations." [F] same page.
- Dropouts: "drawnames intelligently adjusts only the necessary matches, without disturbing the rest of the draw." The organizer can opt out of drawing a name themselves. [F] <https://www.drawnames.com/features/large-groups>
- Redraw and manual assignment: not found.

### Giftster

- Draw needs at least three approved group members; each member can draw anyone unless excluded. [S] <https://help.giftster.com/article/4-secret-santa-draw>
- Exclusions are one-way; stopping two people drawing each other takes two exclusions. [S] <https://help.giftster.com/article/8-draw-gift-exchange-manager-questions>
- Avoid last year: Giftster keeps previous draws and the organizer can choose to exclude the same picks next time. This is opt-in, where Elfster and DrawNames do it automatically. [S] <https://help.giftster.com/article/4-secret-santa-draw>
- Redraw: no reset is documented. The owner can end a draw and start another; the group survives. Only the group owner can start or end a draw. [S] <https://help.giftster.com/article/115-end-a-secret-santa-draw>
- Manual assignment: not found.

### Secret Santa Organizer

- The list is shuffled when the organizer confirms by email. Exclusions need 4 or more participants and cannot be changed once the party starts. Last year's list can be reused. Redraw: not found. [F] <https://www.secretsantaorganizer.com/faq>

## 2. The organizer who also takes part

| Product | Can the organizer see pairings? | Source |
| --- | --- | --- |
| Elfster | Yes. "The only people who can view who everyone has drawn are the Organizers and the Assistants." Hidden by default, opened with "Show All Draws", which "will show who has drawn you as well". | [F] <https://help.elfster.com/en/articles/11500522-how-do-i-see-who-someone-or-everyone-drew> |
| Giftster | No. "The member Giftster picked for you is a secret - not even the organizer knows." | [S] <https://help.giftster.com/article/8-draw-gift-exchange-manager-questions> |
| DrawNames | No. It "keeps every match secret, even from the organizer". The organizer sees progress only (who has drawn, who has a wishlist) and can resend a person's drawn name to that person. | [F] <https://www.drawnames.com/about-us>, [F] <https://www.drawnames.com/how-to-draw-names> |
| Secret Santa Organizer | Yes, opt-in. "You can optionally see the combinations and wishlists on the management page." | [F] <https://www.secretsantaorganizer.com/faq> |

Notes:

- Elfster's peek exists for support: its help centre sends a participant whose gift never arrived to the organizer, who "has access to the list of who drew whom". [S] <https://help.elfster.com/en/articles/11500578-what-do-i-do-if-the-person-who-drew-me-didn-t-send-a-gift> The cost is that a participating organizer who peeks spoils their own surprise; there is no view that hides only their own giver.
- An Elfster blog post claims the organizer cannot see assignments. The help centre contradicts it, and the help centre is the better source. [S] <https://www.elfster.com/blog/draw-names-for-gift-exchange>
- DrawNames: a screenshot caption on the large-groups page mentions a "view draw results" action on past celebrations. Whether that opens pairings to the organizer after the event is unconfirmed. [F] <https://www.drawnames.com/features/large-groups>
- The no-peek products give up the organizer's ability to fix a no-show. Neither Giftster nor DrawNames documents a substitute.

## 3. Purchased and reserved state

**Hidden from the owner, shown to other givers, everywhere.**

- Elfster: marking a wish purchased "won't notify or show up for the Wishlist owner". Other viewers see it is bought. [F] <https://help.elfster.com/en/articles/11517983-how-do-i-mark-that-i-bought-an-item-on-another-elfster-wishlist>
- Giftster: "The list maker's My List view of their list will not show which items are marked purchased or reserved, or who marked them that way." [S] <https://help.giftster.com/article/64-see-item-reserved-or-purchased-on-my-list> Fully claimed items stay on the list for other givers, with a different background colour and the buttons removed. [S] <https://help.giftster.com/article/69-mark-gift-purchased>
- DrawNames: "When someone reserves a gift from a wish list, it's marked as reserved to help avoid duplicate gifts." Others see "Gift reserved. Others can no longer choose it." Whether the owner is shielded is not stated on the page; unconfirmed. [F] <https://www.drawnames.com/features/wish-list-group>
- Giftful: claiming is anonymous and owners of personal lists cannot see claims; other shoppers can. [S] <https://giftful.com/faqs>
- Wishpicks: "Your list hides reservations by default to keep the surprise." [F] <https://docs.wishpicks.com/en/articles/16189864-can-i-see-who-reserved-or-bought-a-gift>

**Exceptions that let the owner see.**

- Giftster child accounts: the managing parent sees reserved and purchased state on the child's list. [S] <https://help.giftster.com/article/72-will-list-maker-see-reserved-purchased>
- Giftful: hidden when a list is "for me"; visible on a registry or a list "for someone else". [S] <https://giftful.com/faqs>
- Wishpicks: the owner can choose "Show what's reserved" for a whole list. The product warns they "can't unsee them", and givers are told while reservations are showing. [F] <https://docs.wishpicks.com/en/articles/16189884-can-i-hide-reserved-gifts-from-myself>

**Is the buyer named to other givers?**

- Elfster: no. "They won't be notified who bought it", and Elfster does not reveal the marker to others in the exchange. [F] Elfster article above.
- Giftster: yes, one click away. The name is covered by a "reveal" label. During an active Secret Santa draw the reveal is disabled on all lists for all participants, since a name would expose the pairing. [S] <https://help.giftster.com/article/73-how-to-shop-for-others>
- Wishpicks: set per list. With "Anyone" can reserve, it reads "Someone reserved this"; with "Only signed-in people", it reads "[name] reserved this". Each reservation keeps the setting it was made under. [F] Wishpicks article above.
- DrawNames: not stated.

**Interim "I'm considering this" state.**

- Giftster is the only one with two states. Its docs call them a convenience: mark "reserved" when you plan to buy and "purchased" once bought. Both block other givers equally, and "release" frees the item. [S] <https://help.giftster.com/article/69-mark-gift-purchased>
- Elfster has purchased only, with "undo mark as purchased". [F] Elfster article above.
- Nobody documents a soft, non-blocking "interested" signal of the kind `docs/use-cases.md` §3 floats ("2 people are interested").

**Marking is manual.** Giftster: using the buy button "does not automatically change the status to purchased". [S] <https://help.giftster.com/article/69-mark-gift-purchased> This is the same failure mode as the families' white-text column: a giver who buys and forgets to mark.

**Giver's own record.** Elfster has a "Gifts I Gave" page; Giftster has "My Shopping List" gathering everything the giver has reserved or purchased across all lists. [S] <https://help.elfster.com/en/articles/11500558-how-can-i-keep-track-of-the-gifts-i-gave-on-other-s-elfster-wishlists>, [S] <https://help.giftster.com/article/99-how-to-use-my-shopping-list>

## 4. Open-ended and multi-quantity wishes

- Elfster: a wish has a quantity. When marking, "if the person wanted more than one", the giver is asked how many they bought. [F] <https://help.elfster.com/en/articles/11517983-how-do-i-mark-that-i-bought-an-item-on-another-elfster-wishlist>, [F] <https://help.elfster.com/en/articles/11504425-how-do-i-add-details-to-a-wishlist-or-wish-like-quantity-size-color-etc>
- Giftster: with a quantity of 2, one tap marks one unit and the item "will still show available" until the second is claimed. When all units are claimed, the buttons go. [S] <https://help.giftster.com/article/69-mark-gift-purchased>
- Giftster reuses the counter for group gifts (no payments are handled): set a quantity and a per-person amount, and each contributor marks one unit. For open-ended needs, it advises a large quantity. [S] <https://help.giftster.com/article/119-group-gifting>, [S] <https://www.giftster.com/essentials/>
- No product documents a true "any number is fine" wish. The workaround is a large number.
- DrawNames, Giftful, Wishpicks: quantity handling not found.

## 5. One wishlist across several groups

- Giftster: lists belong to the member. The default privacy, "shared", shows a list to all of the member's groups. Per-group restriction of a list or of items: not found. [S] <https://help.giftster.com/article/40-how-to-share-a-wish-list>, [S] <https://help.giftster.com/article/121-how-to-change-list-privacy-settings>
- Elfster: wishlists belong to the account, and a person can hold several. Each list's privacy is Public, Limited to chosen gift exchanges, Limited to chosen individuals, or Private. Eligibility is therefore chosen per list, not per item. [F] <https://help.elfster.com/en/articles/11518008-how-do-i-change-the-settings-on-my-elfster-wishlist>
- Purchased state across groups: because both products hang the list off the account and the mark off the item, a mark should be visible to every group that can see the list. Neither vendor states this outright. **Inferred, not confirmed.**
- DrawNames: wishlists are described per celebration or per wish-list group; reuse across groups not found. [F] <https://www.drawnames.com/features/wish-list-group>
- Per-group choice of eligible items from one list: not found in any product.

## 6. Hidden suggestions

- Giftster only. "Suggested Items are just like regular items, except you can secretly add them to another group member's list." The list maker cannot see them; other group members can, along with the suggester's name. Suggesters can edit, delete, reserve or purchase their own suggestions. Requires sharing a group with the list maker. Setting the list private hides suggestions from everyone, and deleting the list deletes them. [S] <https://help.giftster.com/article/98-what-are-suggested-items>, [S] <https://help.giftster.com/article/97-add-items-to-other-member-lists>
- The last point is the hazard ADR 0027 names: hidden content lives and dies with the owner's list, and the owner can destroy it without knowing it exists.
- A use beyond gift ideas: parents add to a partner-managed child's list this way. [S] <https://www.giftster.com/news/child-list-suggested-items/>
- A Giftster app-store reviewer wants it most for relatives who will not fill in their own list. [2] <https://apps.apple.com/us/app/giftster-wish-list-registry/id478126039>
- Elfster, DrawNames, Giftful, Wishpicks: not found.

## 7. Free-for-all versus assigned

- Giftster is free-for-all by default: a standing group whose members all see and shop each other's lists year-round. A Secret Santa draw is an optional event the owner starts and ends inside the group. While a draw runs, buyer-name reveal is disabled group-wide. [S] <https://help.giftster.com/article/87-getting-started-groups>, [S] <https://help.giftster.com/article/115-end-a-secret-santa-draw>, [S] <https://help.giftster.com/article/73-how-to-shop-for-others>
- DrawNames offers two group types: a celebration with a draw, and a "wish list group" with no date, where "everyone gets their own wish list" and wishes are added "throughout the year". In draw groups too, "all wish lists are visible to everyone in the celebration" by default. [F] <https://www.drawnames.com/features/wish-list-group>
- Elfster is exchange-first. Wishlists live on the account and can be followed outside any exchange, which gives a loose free-for-all. [F] <https://help.elfster.com/en/articles/11518008-how-do-i-change-the-settings-on-my-elfster-wishlist>
- In every assigned mode found, the assignment controls only what the giver is told. It does not restrict who can see a list or mark an item. Whether non-assigned members may mark items in assigned mode is not addressed by any vendor.

## 8. Revealing giver identities

- No product documents an automatic or scheduled reveal of who drew whom.
- Giftster: "No one will know who chose whom until you do the exchange, even the group organizer." Reveal is the in-person event. [S] <https://www.giftster.com/news/giftster-makes-secret-santa-gift-exchanges-fun-and-easy/>
- Elfster: messages and questions to a giftee can be marked anonymous. The only documented after-the-end unmasking is that a wishlist follower's name appears once the exchange has ended. [S] <https://help.elfster.com/en/articles/11480255-how-do-i-find-out-who-i-drew-in-my-elfster-gift-exchange>, [S] <https://help.elfster.com/en/articles/11518231-am-i-anonymous-if-i-follow-someone-on-the-elfster-friends-page>
- Buyer identity on wishlist items is the nearest thing to a reveal control: Giftster's click-to-reveal (off during a draw) and Wishpicks' per-list anonymity setting, both covered in §3.

## 9. Sign-in friction

- Elfster: "Everyone needs to have their own Elfster account." For someone without email: a Family Manager linked account under the main holder's email (username and password); or a "Draw Now" exchange where the organizer enters names and runs everything, and those participants get no wishlist and cannot view their own draw; or texting the invite link. [F] <https://help.elfster.com/en/articles/11500530-how-do-i-invite-someone-without-an-email-address>
- Giftster: an account is needed to join a group; a join request needs the owner's approval. Child accounts sit under a parent's email with no separate login. For adults without email, the help centre suggests the group creator register accounts for them with a temporary password. Guests can mark items on a public list without signing up. [S] <https://help.giftster.com/article/67-how-to-join-group>, [S] <https://help.giftster.com/article/66-how-child-accounts-work>, [S] <https://help.giftster.com/article/34-4-ways-to-get-your-group-started>, [S] <https://help.giftster.com/article/42-register-to-use-giftster>
- DrawNames: "No registration required." One invitation link is shared by text, email or any app, and each person joins with a name and email. Personal links to the wishlist and group page arrive by email, with a retrieval page for lost ones. An account is optional. [F] <https://www.drawnames.com/how-to-draw-names>, [F] <https://www.drawnames.com/features/large-groups>, [F] <https://www.drawnames.com/about-us>
- Secret Santa Organizer: "no account, no app, no paywall". Each participant gets a personal emailed link; the organizer can resend it or correct the address. [F] <https://www.secretsantaorganizer.com/faq>
- Giftful: an account is needed to view and claim by default; "Anyone With Link Can View" opens viewing. Claiming without an account: unconfirmed. [S] <https://giftful.com/faqs>
- Wishpicks: by default anyone can reserve without signing in; the owner can require sign-in. [F] <https://docs.wishpicks.com/en/articles/16189910-how-do-i-reserve-a-gift-before-buying>

The split is consistent: products with rich wishlist state (Elfster, Giftster) require accounts and need a managed sub-account for children; products built on personal email links have thinner state. A personal link is a bearer credential, so forwarding it hands over the pairing.

## 10. Well-known complaints

All secondary, anecdotal, and unverified. Useful as a list of things to avoid, not as measurements.

- **Email volume and unwanted enrolment (Elfster).** Trustpilot reviewers report emails continuing after unsubscribing, being added to an exchange without signing up, and having to create an account to ask for removal. [2] <https://www.trustpilot.com/review/elfster.com>
- **Duplicate accounts (Elfster).** A reviewer who used a different email got a second account. Elfster keeps a help article for it. [2] same; [S] <https://help.elfster.com/en/articles/11475734-what-do-i-do-if-someone-signed-up-twice>
- **Purchased items hard to tell from available ones (Giftster).** "I do wish there was more color contrast between the purchased and available items." [2] <https://apps.apple.com/us/app/giftster-wish-list-registry/id478126039>
- **Parents cannot see what has been bought for their children (Giftster)** unless the list is set up as a child account. [2] same.
- **Older relatives do not fill in lists (Giftster).** "We have a few elderly folks that don't always want to put stuff on their list." [2] same.
- **Account and wishlist glitches (DrawNames).** Password-reset failures and being unable to remove a wishlist item, per a review aggregator. Weak evidence. [2] <https://justuseapp.com/en/app/932002377/drawnames-tirage-au-sort/contact>
- **Forgetting to mark.** Not a review complaint but a structural one the vendors document themselves: buying does not mark (§3).

Reddit threads and Elfster's App Store reviews were searched for and not retrieved, so complaints here under-sample. Ads and affiliate links, a common grumble about this category, could not be sourced and are left out.

## Gaps

- All Giftster and Giftful claims rest on search excerpts of the vendors' pages.
- Purchased state crossing groups is inferred from the data model, not stated by any vendor.
- Not found for any product: full manual assignment of every pairing; per-group item eligibility; a non-blocking "interested" state; a scheduled identity reveal; an explicit unlimited-quantity wish.
- Not found for DrawNames: redraw, whether the list owner is shielded from reserved state, whether the reserver is named, wishlist reuse across groups.
- A hands-on trial of Giftster and Elfster with two test accounts would settle the cross-group and DrawNames questions in under an hour.
