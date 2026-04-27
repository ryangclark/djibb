# djibb use cases

We're building djibb, which is remixable checklists. Three use cases to keep in mind while building djibb: recipe, camping pack checklist, secret santa. I've done a kind of markdown here for each, but we may want to formalize some of the spec as we go to grow djibb's support for getting a list out of djibb ("copy as .md" or "export as .md"), or vice-versa.

One of the key things to note across these use cases is their diversity. I think it's neat that you can accurately describe each of the use cases with a list, but I'm not sure it's 100% intuitive. The frontends for each of these use cases is ideally quite different and built specifically for those use cases. But a djibb list can power them all.

In fact, each NFL team could have its own djibb template embedded in their marketing website for their team's version of tailgating (and fans could then use that template to make their own List). Cincinnati would have Skyline dip on theirs, and the Eagles would have all their crazy shit on theirs. But they could all be powered by djibb.

## 1. Recipe

What is a recipe, but a repeatable, templated list of ingredients and list of instructions? Here's a favorite recipe from Bravetart.

### Philadelphia-style strawberry ice cream

With this recipe, I'm able to cram two pounds of strawberries into a quart of ice cream. The trick is to toss the berries and sugar into a hot oven to rapidly extract their juice, then simmer it down into a ruby red syrup. This one-two method is faster than roasting or simmering alone, so it helps keep the flavor fresh. It also concentrates the strawberry essence by eliminating excess (icy, tasteless) water. The result is a silky, pale pink ice cream that tastes like pure strawberries and cream.

Yield: about 1 quart
Active time: 1 hour
Downtime: 4-hour regrigeration

#### Ingredients

- [] (7 cups | 32 ounces) whole strawberries, washed and drained
- [] (3/4 cup | 5-1/4 ounces) sugar
- [] (1/8 tsp) Diamond Crystal kosher salt (half as much if iodized)
- [] (1-3/4 cups | 14 oz) cold heavy cream
- [] (1 tbsp) freshly squeezed lemon juice
- [] (1/4 tsp) rose water
- [] (2 tsp) Frangoli, framboise, St-Germain, or vodka

#### Roast and concentrate the fruit

Adjust oven rack to middle position and preheat to 375ºF. Slice off the strawberries' leafy caps, removing as little fruit as possible. Halve the beries, place in a 9-by-13-inch glass or ceramic baking dish, then stir in the sugar and salt.

> Key Point: The stwaberry syrup may bubble out of a baking dish smaller than 7-by-11 inches or roast too quickly in one that is larger than 9-by-13 inces or made of metal.

Roast, stirring once or twice along the way, until the berries are fork-tender and swimming in bright red juice, about 35 minutes. Strain through a dobule-mesh sieve into a 3-quart stainless steel saucier, gently mashing the berries with a flexbile spatula until only 1/2 cup (5 ounces) remains; discard.

Simmer strawberry juice over medium heat, scraping the pot with a heat-resistant spatula until thick, syrupy, and reduced to 1-2/3 cups (16 ounces), about 15 minutes. Whisk in cream, lemon juice, rose water, and liqueur. Cover and regrigerate until very cold, at least 4 hours, or up to 1 week.

#### Finish the ice cream:

Churn according to the manufacturer's directions until the ice cream is fluffy and light. If your machine has an open top, cover with an inverted cake pan to keep it cold as it churns. Meanwhile, place a flexible spatula and quart ontainer (an empty yogurt tub works great) in the freezer.

Enjoy freshly churned ice cream as "soft serve," or scrape it into the chilled container. Press a shee of plastic against the ice cream to mininize risk of freezer burn and seal. reze until firm enough to scoop, about 12 hours, or up to 3 weeks.

#### Mix it up! (variations)

##### Peach:

Wash 38 ounces (about 6 medium or 4 large) ripe yellow peaches, but do not peel. Pit the peaches and cut into 1-inch chunks. Roast, strain, and simmer as directed, allowing an extra 10 minutes for the syrup to cook down. Reduce the cream to 1-1/2 cups (12 ounces), and pair with a peach liqueur such as Mathilde Peche.

**Notes:**

- You'd want to be able to scale a recipe, say if you wanted to double it for a party. That might just be a frontend concern, however, when starting a List from a template.
- Convert measurements between imperial and metric.
- The Variations section makes me think there's a remixable component to this, but I'm not sure that's true...
- In my dream recipe SPA/website, it'd present the ingredients in several ways to be most useful for the user's context:
    - A full list of ingredients at the top (traditional style), which is great for an overview plus for making a shopping list
    - A list of the ingredients relevant to the current section, displayed just above the section, so you don't have to 1) keep scrolling up to the Ingredients section, and 2) mentally isolate the section of the ingredients list relevant to my current section. This also is great for when you have top-level ingredient like "8 tbsp. butter, divided" you can then just show the amount of butter needed for the current step: 6 tbsp. butter, melted.
    - Inline measurements, for example "combine the 1/2 tsp. cumin with the 1/2 tsp. chili powder", but this might be overkill if we have the sublists as described above

## 2. Camping pack checklist

This is where the "remixable" part of djibb is supposed to shine. When packing for a camping trip, there are some core essentials, such as a tent. But _which_ tent we bring depends on if we are backpacking (packing light) or car camping (little bouji). Below is an rough example of a list for car camping, but I think you can see how a backpacking version would be related yet distinct.

- [] Tent
- [] Water jug
- [] Food
    - [] Coffee
    - [] Dessert
- [] Water bottles
- [] Cookware
    - [] Pot
    - [] Pan
    - [] Stove
    - [] Fuel canister
    - [] JetBoil
    - [] Cutlery
    - [] Bowls
    - [] Tin cups
- [] Lewis (the dog)
    - [] Bandana
    - [] Food (two scoops per day)
    - [] Bed
    - [] Leash
    - [] Fleece jacket
- [] Sunscreen
- [] Clothing, Ryan
    - [] Hat
    - [] Underwear
    - [] Shorts
    - [] Shirts
    - [] Socks
- [] Clothing, Cori
    - [] Hat
    - [] Underwear
    - [] Pants
    - [] Shirts
    - [] Socks
- [] Blankets
- [] Batteries, AAA
- [] Camp table
- [] Camp chairs
- [] Cooler

**Notes:**

- The list output above would be from a templates mixed together, I'm not 100% sure how it would work in practice but here's the idea: you'd have created a set of djibb templates/patterns for camping, and you combine them as needed for your current context. So if we are car camping with Lewis for two nights in Moab in mid April, then Cori and I know what to bring. We create a List from the combined patterns/templates, and use that List to pack. Then, when we are on the trip, we can realize we forgot AA batteries, and then add that to the pattern/template for next time, so it's self improving. We can also nudge the user with an email two days after a trip, saying "how did your list hold up? anything to note for next time?" to prompt them to capture their experience
- We'd likely be offline in the camping hypotheticals, so offline support is a top-level use-case for djibb.
- In the "car camping with Lewis for two nights in Moab in mid April" example, it'd be cool - but maybe overdoing it - to have attributes/parameters on Template Items, such that you can enter context into a template/pattern, and have the outputted packing list reflect that context. For example, two nights means we need 2 x 2 gallons of water, four sets of underwear (1 pair per day, plus two backups per trip), colder clothing because of April nights in the desert, etc. So the Template Item can refer to top-level List attributes so the user/agent using the templated List enters those details once and they carry through, idk.
- If you've never camped before, djibb can show you well-used checklists from the community/workspace, or you can chat with a llm agent to make a customized starter list/template

## 3. Secret Santa helper

I'll explain how we do things today, and I think you can imagine how djibb could make it better.

So right now, we have two secret santa lists. We do it in Google Sheets, and we make a new sheet every year (duplicate the previous year, technically). Each person has their own tab, and the tab is a table of gift list. They enter each item/idea, a description, any size/color preferences, a URL if any, a price, etc. The final column is Purchased, and it's white text on white background, and the person who bought the item is supposed to mark it with an X or their initials in the column so others know it's taken (by lookign at the cell value in the formula bar, which the, uh, older users don't always understand/comply, resulting in duplicate gifts christmas morning lol) while the gift owner intentionally doesn't look at that column and can't see the white text. We have a sheet for both families, so you have to maintain the list in multiple places and decide whether to share the idea across both or not because one family can't see if another person in the other family purchased the item, so you have to be selective kinda, too.

Thoughts on a better way with djibb:

- A gift list is just a list!
- Each user curates their list, much list today
- User can participate in Secret Santa gift exchanges
    - Invite all participants to the workspace
    - They can populate their lists from their top-level list (exclude certain items, or only select certain items, etc.), and any "mark as purchased/completed" action would bubble up from the workspace to the top-level list, so others seeing that item in another secret santa session know it's taken
        - Could do a "2 people are interested" in this item as an interim status before someone finally marks it? idk
- People can ask for and suggest gift ideas for others without the person seeing it (only display if suggestions to visitors of the list, not the owner), and then still mark those suggested items as taken, and I think that's a pretty slick idea
