# 💀 The Necromancer: HW Revitalize Weapon Queue Bot

By **Eaglewing [571041]**

A Discord bot that runs Halloween-event queues for your faction's Revitalize weapons. **Every channel gets its own independent queue**: its own weapon pool, waiting line and clickable panel. Members join the queue, and whenever a weapon in that channel frees up, the next person in line is @'d and given it for a 15-minute slot (by default). Members can't pick a specific weapon.

Members loan the weapon to themselves from the faction armoury and return it by hand. The bot never loans or retrieves anything. With an optional Torn API key, it reads the faction armoury log to **confirm loans and returns** (see [Torn API loan checks](#torn-api-loan-checks-optional)).

## How it works

1. A member presses **🎃 Join queue** on a channel's panel.
2. When a weapon in that channel is free, the bot gives it to the next person in line and **@mentions them**, naming the weapon.
   **Members loan the weapon to themselves** in the [faction armoury](https://www.torn.com/factions.php?step=your&type=1#/tab=armoury&start=0&sub=weapons). The bot links there but never loans anything.
3. They have **2 minutes** to press **🙋 Claim** on that @ message. Claim only appears there, not on the panel, so the tag is where you act. If they don't, they lose their place and the next person is called. They can also press **Pass**.
4. Claiming starts their **15-minute slot**. They take that weapon from the faction armoury.
5. At 2 minutes left they get a ping. At 0 they're pinged to return it, and the next person is @'d.
6. **🏁 Finished** hands the weapon on early. **👋 Leave queue** leaves the line or ends a turn.

When several weapons are free, the **highest bonus %** is handed out first. The panel lists weapons highest % first. With 3 weapons, the first 3 people in line are served at once. A member can be in several channels' queues at the same time.

## Keeping channels tidy

- **The panel is never re-posted.** It's edited in place, at most once every 1.5 seconds even during a rush.
- **Each turn is one message** that's edited as it goes: *you're up* → *claimed* → *ended*.
- The only extra messages are the **"2 minutes left"** and **"time's up"** pings (edits don't notify people, so these must be new messages).
- **All of a turn's messages are deleted automatically** 2 minutes after the turn ends (`CLEANUP_SECONDS`, 0 = keep them). The channel only ever shows the panel and turns in progress.
- All button replies are private, so only the person who clicked sees them.

## The panel

The panel shows each weapon with its bonus, who has it and how long they have left, plus the queue with a countdown to each person's turn. Its buttons are **🎃 Join queue**, **👋 Leave queue**, **🏁 Finished**, **📋 My status**, **✏️ Set Torn name** and **🛠️ Admin** (admins only).

## Setting up a channel

In each channel that should have a queue:
1. `/qadmin panel`: posts the panel and creates the channel's queue. Pin it if you like.
2. `/qadmin add-weapon name bonus percent` for each weapon in that channel's pool, e.g. `name:Scythe bonus:Revitalize percent:25` shows as **Scythe (Revitalize 25%)**.

## Weapon UIDs (optional)

Every bonus weapon in Torn, including ranked war weapons, has its own unique ID (UID), e.g. `9171132718`. Registering it is optional but recommended:

- **The member is told exactly which one to take.** Their turn message shows "🔎 UID 9171132718: take this exact one from the armoury".
- **Identical weapons can both be added.** Two weapons with the same name, bonus and % are kept apart by their UIDs.
- **Same-type weapons are grouped.** Copies with the same name and bonus (e.g. two MP5 Navy, Revitalize 12% and 14%) show as one entry, "MP5 Navy (Revitalize 12–14%) ×2, either one". Whoever is called can loan **either** copy and it counts, because Torn's armoury log only names the weapon type. Taking a copy of that type while one is still free is never treated as an out-of-turn loan.
- **A UID can only be registered once,** across all channels, so the same weapon can't be in two queues.
- **With a Torn API key, the UID is enough.** Leave name, bonus and % blank and the bot fills them in from Torn. Without a key, enter them yourself as well.

To find UIDs, use the **Torn Weapon UID Finder** userscript (`torn-weapon-uid-finder.user.js`). It lists each bonus weapon's UID on the faction armoury and Items pages you're viewing, with copy buttons.

**Note:** the armoury log and armoury API name the weapon *type* ("Scythe"), not its UID. Loan checks confirm that the member loaned a Scythe, not which one. The UID on their turn message is what steers them to the right one.

## Admin panel (buttons)

Admins can press **🛠️ Admin** on any channel's panel to open private controls that only they can see. Everyone else gets "Admins only".

| Button | What it does |
|---|---|
| ➕ Add weapon | Form for UID (optional), name, bonus and bonus %. With an API key, a UID alone is enough. |
| ➖ Remove weapon | Pick from this channel's weapons |
| ⏭️ Skip a turn | Pick a weapon in use. The holder's turn ends. |
| 👤 Add member | Discord's member picker. Adds them to the back of the queue. |
| 🚫 Remove member | Member picker. Takes them out of the queue or ends their turn. |
| ↕️ Move member | Member picker, then type the new position |
| ⚙️ Settings | Form with this channel's timings. Leave a box blank to use the default. |
| 🔑 API test | Same as `/qadmin api-test` |
| 📌 Re-post panel | Posts a fresh panel and deletes the old one |
| 🧹 Clear queue / 🪦 Delete queue | Both ask for confirmation first |

Buttons that don't apply right now are greyed out, e.g. Move when nobody is waiting. The `/qadmin` commands below still work too.

## Commands

All commands apply to **the channel they're used in**.

**Everyone** (these are also buttons on the panel)
- `/queue join [torn_name]`, `/queue leave`, `/queue status`

**Admins**: anyone with a role whose name contains **Leader** or **Council**, e.g. "Faction Leader", "Leadership" or "Council Member" (`ADMIN_ROLE_KEYWORDS`; the 🛠️ Admin controls list which roles matched), anyone whose Discord user ID is in `ADMIN_USER_IDS`, the role in `ADMIN_ROLE_ID`, or anyone with Manage Server
- `/qadmin panel`: post (or re-post) this channel's panel
- `/qadmin add-weapon [name] [bonus] [percent] [uid]`: add a weapon to this channel's pool (with a key, `uid` alone is enough)
- `/qadmin remove-weapon weapon`: remove a weapon. If someone had just been given it and hadn't claimed yet, they go back to the front of the queue.
- `/qadmin add-user user [torn_name]`: add someone to the back of the queue
- `/qadmin remove-user user`: remove someone from the queue or end their turn
- `/qadmin skip weapon`: end whoever's turn is on that weapon
- `/qadmin move user position`: move someone to a new place in the queue (1 = front)
- `/qadmin clear`: empty the waiting queue (current holders keep their slots)
- `/qadmin delete-queue`: delete this channel's queue, weapons and panel
- `/qadmin settings`: view or change this channel's timings (see below)
- `/qadmin api-test`: check the Torn API key and show the latest armoury log lines and how the bot read them

## Per-channel settings

Each channel has its own timings. Run `/qadmin settings` with no options to see them, or set any of:

| Option | What it does | Default |
|---|---|---|
| `slot_minutes` | How long each person keeps the weapon | 10 |
| `claim_minutes` | How long they have to press Claim | 2 |
| `warn_minutes` | "Time almost up" ping, minutes before the end (0 = off) | 2 |
| `cleanup_seconds` | Delete finished turn messages after this long (0 = keep) | 120 |
| `return_remind_minutes` | API only: remind someone this long after their slot if the weapon isn't back | 5 |
| `reset` | Put this channel back to the defaults | |

Example: `/qadmin settings slot_minutes:15 claim_minutes:3`. Changes apply to new turns. Anyone mid-turn keeps the time they were given. The panel updates to show the new timings. The defaults come from `.env`.

## Install

1. **Create the bot:** go to https://discord.com/developers/applications → New Application → **Bot** tab → Reset Token and copy it. No privileged intents are needed.
2. **Invite it:** OAuth2 → URL Generator → scopes `bot` + `applications.commands`; permissions **View Channels**, **Send Messages**, **Embed Links**, **Read Message History**. Open the URL and add it to your server. Make sure it can see every queue channel.
3. **Get IDs:** Discord Settings → Advanced → Developer Mode on. Right-click the server and (optionally) the admin role → Copy ID.
4. **Run it:** you need Node.js 18+.
   ```
   npm install
   cp .env.example .env    # then fill in .env
   npm start
   ```

The values in `.env` are the defaults for every channel. Each channel can change its own with `/qadmin settings`.

Everything (queues, weapons, timers, Torn names, panels, pending clean-ups) is saved to `queue-data.json`, so a restart picks up where it left off. Keep the bot running for the event on a VPS, a Raspberry Pi, or a host like Railway / fly.io with a persistent volume. Use `pm2` to keep it running.

**Note:** the bot can't see the armoury, so returning weapons on time relies on members. Members need armoury permission to loan weapons to themselves.

## Torn API loan checks (optional)

Add `TORN_API_KEY` to `.env` and restart. While anyone has a weapon or owes a return, the bot reads your faction's armoury log every 30 seconds (`API_POLL_SECONDS`) and:

- **Shames queue jumpers.** If someone loans a weapon while it's another member's turn, the bot posts a public, spooky call-out in that channel (tagging them if it knows their Discord, otherwise naming them). Each loan is called out once; loans from before the turn started don't count, and nobody is shamed when the bot can't be sure who's who.
- **Auto-claims.** If the member who is up loans their weapon before pressing Claim, the bot claims for them as soon as the loan shows in the log (within `API_POLL_SECONDS`). They can still press Claim themselves.
- **Confirms loans.** When "*Name* loaned 1x Scythe…" appears for the current holder, their turn message and the panel show **✅ loaned**. Until then the panel shows **⏳ loan not seen yet**.
- **Ends turns early on return.** If the holder returns the weapon before their time is up, their turn ends and the next person is called.
- **Tracks late returns.** If the slot ends and the return hasn't shown up, they're listed under **👻 Not returned yet** on the panel. After `return_remind_minutes` they get one reminder ping. It clears when the return or an officer's retrieval appears in the log.

**Linking members to Torn names:** when a member joins or claims, the bot looks them up by their Discord ID. This works if they've linked Discord in Torn's settings. Anyone else can press **Set Torn name** on the panel. Without a Torn name, the bot can't confirm that member's loans. Everything else still works.

**Getting a key:** the key must belong to a faction member with **faction API access**, which faction leadership can grant. A key with **Minimal** access should be enough. If it isn't, `/qadmin api-test` will say so.

**First run:** run `/qadmin api-test` once the key is in. It shows the latest armoury log lines and how the bot read each one (loan / return / not recognised). I couldn't check Torn's exact wording when writing this. If lines show as "not recognised", the patterns in `torn.js` (`parseArmoury`) need a small tweak.

**Limits:**
- The armoury log names the item ("Scythe") but not its bonus. Two weapons with the same name in one pool are matched by name only.
- The bot only sees what's in the log. Loans by officers to the member count. Trades outside the armoury don't.
- If the key stops working (wrong key, access removed), the bot pauses checks for 10 minutes and logs the reason. `/qadmin api-test` shows it.

## Torn rules compliance

The bot **never requests torn.com pages**. Its only contact with Torn is optional, read-only calls to the official API (`api.torn.com`): the faction armoury log and user basic info. Automated API calls are allowed under Torn's rules. Members loan and return weapons themselves in the armoury. Buttons only change the Discord queue.

Don't add automation that loans or retrieves items on a timer. The Torn API has no loan endpoint, and scripting the armoury page to do it would break Torn's rules on automated non-API requests.

## Terms of Service

This bot uses Discord. By using it you agree to Discord's Terms of Service: https://discord.com/terms
With a key set, it also uses the Torn API, under Torn's API terms: https://www.torn.com/api.html

**Without a Torn API key:**

| | |
|---|---|
| **Data Storage** | Only locally: Discord user IDs, queue positions and any Torn name a member chooses to set are kept in `queue-data.json` on the bot host. Torn names stay until the member clears them. |
| **Data Sharing** | Faction (anyone who can see a queue channel can see its panel) |
| **Purpose of Use** | Public community tools (faction weapon loan scheduling) |
| **Key Storage & Sharing** | Not stored / Not shared (no Torn API key is used) |
| **Key Access Level** | None required |

**With a Torn API key (loan checks on):**

| | |
|---|---|
| **Data Storage** | Only locally: as above, plus linked Torn IDs/names and loan/return times, in `queue-data.json` on the bot host. Armoury log lines are read, not stored. Return records are dropped once the weapon is back, or after 12 hours. |
| **Data Sharing** | Faction (loan status and unreturned weapons show on the panel to anyone who can see the channel) |
| **Purpose of Use** | Public community tools (confirming faction weapon loans and returns for the queue) |
| **Key Storage & Sharing** | Stored / Used only for automation (in `.env` on the bot host; never shown in Discord or logs) |
| **Key Access Level** | Minimal, from a member with faction API access. Uses only: faction › news (armoury) and user › basic |


## Tranche API keys (one per faction)

Each queue channel must be linked to one 39th tranche: **until it is, the queue is locked** (the panel shows a set-up notice and Join is greyed out). That channel then reads **that tranche's** armoury log with **that tranche's** key, and only members of that faction can join.

1. The bot owner sets `KEY_SECRET` in Railway once (a long random string; never change it).
2. In the queue channel: 🛠️ **Admin** → 🔑 **API keys** → 🏷️ **Set this channel's tranche**.
3. A leader presses 🆕 **Create key in Torn** (opens Torn's key page with only `faction → armorynews` ticked), creates the key, then ➕ **Add / replace key**, picks the tranche and pastes it into the private pop-up.
4. The bot tests the key, checks it belongs to that faction, encrypts it and shows ✅. ❌ = no key, ⚠️ = Torn stopped accepting it.

Keys are never displayed, logged or readable back by anyone; they can only be replaced or removed. Member names and the join check use the bot owner's key (public data only).

**Terms for tranche keys**

| | |
|---|---|
| Data Storage | Only locally: linked Torn names and loan/return times |
| Data Sharing | Faction: loan status on that channel's queue panel |
| Purpose of Use | Public community tools: confirm armoury loans and returns |
| Key Storage & Sharing | Stored (encrypted) / Used only for automation |
| Key Access Level | Custom: faction > armorynews |

[Torn API terms](https://www.torn.com/api.html)


## 📅 Booking a slot

Members can press **📅 Book a slot** on the panel, pick **Any weapon** or a specific one, then a start time (Torn City Time, every 15 min, from 1 to 12 hours ahead).

- At their time they're tagged for that weapon **ahead of the queue** and loan it as usual (auto-claimed). Miss the claim window and the booking is released.
- Queue turns that would run into a booking are cut short to end at the booking time; if that would leave under ~7 minutes, the weapon is held for the booking instead.
- 1 booking per member at a time. By default one weapon is always left for the walk-up queue, so with 3 weapons at most 2 can be booked for the same time (admins can set this to 0 so single-weapon channels can be booked). Identical copies (e.g. two MP5 Navy) are booked as a pair, "either one".
- Bookings show on the panel and in **📋 My status**, with **🔁 Move booking** (another time or weapon) and **Cancel**.
- **Cooldown:** after a booked slot, a member's next booked slot can't start until the cooldown has passed (default 60 min, 0 = off).
- Admins: 🛠️ **Admin** → 📅 **Bookings** to turn booking on/off for the channel and change the booked slot length (default 15 min) and the cooldown.
