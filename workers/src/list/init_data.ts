import type { ListElement } from './index';

export function init(storage: DurableObjectStorage) {
	console.log(
		'~~~ INITIALIZING LIST "Philadeliphia-style strawberry ice cream" !! ~~~'
	);

	const currentList = strawberryIceCreamRecipe;

	for (const element of currentList) {
		storage.put(
			// Create the key for this element.
			// The top-level list has a special key.
			element.type === 'list' ? '_this' : `${element.type}/${element.id}`,
			{ ...element, version: 2 }
		);
	}
}

// This is a list in TypeScript form, which makes it easier to ensure
// its data matches the required types.
//
// It'd be nice to have a JSON file version of this, too, to begin
// working toward testable shit plus saveable data.
const strawberryIceCreamRecipe: Array<ListElement> = [
	{
		child_element_refs: ['group/g1', 'group/g2'],
		description:
			"(Recipe by Stella Parks in Bravetart.)\nWith this recipe, I'm able to cram two pounds of strawberries into a quart of ice cream. The trick is to toss the berries and sugar into a hot oven to rapidly extract their juice, then simmer it down into a ruby red syrup. This one-two method is faster than roasting or simmering alone, so it helps keep the flavor fresh. It also concentrates the strawberry essence by eliminating excess (icy, tasteless) water. The result is a silky, pale pink ice cream that tastes like pure strawberries and cream.",
		id: 'ts5V_Qj_Qa0CiYeu5d511',
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: 'Philadeliphia-style strawberry ice cream',
		type: 'list',
		version: 1,
	},
	{
		id: 'g1',
		child_element_refs: [
			'item/i6',
			'item/i7',
			'item/i8',
			'item/i9',
			'item/i10',
			'item/i11',
		],
		parent_element_ref: 'list/ts5V_Qj_Qa0CiYeu5d511',
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: 'Ingredients',
		type: 'group',
		version: 1,
	},
	{
		id: 'g2',
		child_element_refs: ['group/g3', 'group/g4'],
		parent_element_ref: 'list/ts5V_Qj_Qa0CiYeu5d511',
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: 'Steps',
		type: 'group',
		version: 1,
	},
	{
		id: 'g3',
		child_element_refs: ['item/i1', 'item/i2', 'item/i3'],
		parent_element_ref: 'group/g2',
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: 'Roast and concentrate the fruit',
		type: 'group',
		version: 1,
	},
	{
		id: 'g4',
		child_element_refs: ['item/i4', 'item/i5'],
		parent_element_ref: 'group/g2',
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: 'Finish the ice cream',
		type: 'group',
		version: 1,
	},
	{
		id: 'i1',
		parent_element_ref: 'group/g3',
		quantity: {
			target_value: 1,
			unit: 'BOOL',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title:
			"Adjust oven rack to middle position and preheat to 375º. Slice off the strawberries' leafy caps, removing as little fruit as possible. Halve the berries, place in a 9-by-13-inch glass or ceramic baking dish, then stir in sugar and salt.",
		type: 'item',
		version: 1,
	},
	{
		id: 'i2',
		parent_element_ref: 'group/g3',
		quantity: {
			target_value: 1,
			unit: 'BOOL',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title:
			'Roast, stirring once or twice along the way, until the berries are fork-tender and swimming in bright red juice, about 35 minutes. Strain through a double-mesh sieve into a 3-quart stainless steel saucier, gently mashing the berries with a flexible spatula until only 1/2 cup (5 ounces) remains; discard pulp, or refrigerate for up to a week for another use.',
		type: 'item',
		version: 1,
	},
	{
		id: 'i3',
		parent_element_ref: 'group/g3',
		quantity: {
			target_value: 1,
			unit: 'BOOL',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title:
			'Simmer strawberry juice over medium heat, scraping the pot with a heat-resistant spatula until thick, syrupy, and reduced to 1-2/3 cups (16 ounces), about 15 minutes. Whisk in cream, lemon juice, rose water, and liqueur. Cover and refrigerate until very cold, at least 4 hours, or up to 1 week.',
		type: 'item',
		version: 1,
	},
	{
		id: 'i4',
		parent_element_ref: 'group/g4',
		quantity: {
			target_value: 1,
			unit: 'BOOL',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title:
			"Churn according to the manufacturer's directions until the ice cream is fluffy and light. If your machine has an open top, cover with an inverted cake pan to keep it cold as it churns. Meanwhile, place a flexible spatula and quart container (an empty yogurt tub works great) in the freezer.",
		type: 'item',
		version: 1,
	},
	{
		id: 'i5',
		parent_element_ref: 'group/g4',
		quantity: {
			target_value: 1,
			unit: 'BOOL',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title:
			'Enjoy freshly churned ice cream as "soft serve," or scrape it into the chilled container. Press a sheet of plastic against the ice cream to minimize risk of freezer burn and seal. Freeze until firm enough to scoop, about 12 hours, or up to 3 weeks.',
		type: 'item',
		version: 1,
	},
	{
		id: 'i6',
		parent_element_ref: 'group/g1',
		quantity: {
			target_value: 32,
			unit: 'ONZ',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: '32 ounces whole strawberries, washed and drained',
		type: 'item',
		version: 1,
	},
	{
		id: 'i7',
		parent_element_ref: 'group/g1',
		quantity: {
			target_value: 5.25,
			unit: 'ONZ',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: '5-1/4 ounces sugar',
		type: 'item',
		version: 1,
	},
	{
		id: 'i8',
		parent_element_ref: 'group/g1',
		quantity: {
			target_value: 14,
			unit: 'ONZ',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: '14 ounces cold heavy cream',
		type: 'item',
		version: 1,
	},
	{
		id: 'i9',
		parent_element_ref: 'group/g1',
		quantity: {
			target_value: 1,
			unit: 'TBSP',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: '1 tablespoon freshly squeezed lemon juice',
		type: 'item',
		version: 1,
	},
	{
		id: 'i10',
		parent_element_ref: 'group/g1',
		quantity: {
			target_value: 0.25,
			unit: 'TSP',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: '1/4 teaspoon rose water',
		type: 'item',
		version: 1,
	},
	{
		id: 'i11',
		parent_element_ref: 'group/g1',
		quantity: {
			target_value: 2,
			unit: 'TSP',
			value: 0,
		},
		time_created: new Date().toISOString(),
		time_deleted: null,
		time_updated: new Date().toISOString(),
		title: '2 teaspoons Fragoli, frambiose, St-Germain, or vodka',
		type: 'item',
		version: 1,
	},
];
