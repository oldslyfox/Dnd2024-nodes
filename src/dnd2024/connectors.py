"""Task 1 - connector node generation.

Connectors are invented content (nothing here is copied from any book). They
exist for two reasons:

1. Pathing currency. The 735 extracted nodes are all notable-tier; without
   filler there is nothing to walk *through*, so distance cannot cost anything.
2. Depth normalization (Task 2d). Zones have wildly uneven real-node density
   per level. A full 1..20 connector ladder in every zone makes "level 10" land
   at the same graph-distance from the hub no matter whose zone you are in.

All connectors are flat 1 point like everything else (Task 4). The pathing
engine (Task 5) is what makes a player's *own* zone spine free to walk.
"""

from __future__ import annotations

from . import config

# Six themed minor bonuses per zone, cycled along that zone's ladder. Small
# numeric or flavour effects only.
ZONE_POOL: dict[str, list[tuple[str, str]]] = {
    "Barbarian": [
        ("Hardened Sinew", "You have a +1 bonus to Strength (Athletics) checks."),
        ("Blood Memory", "You have a +1 bonus to Constitution saving throws made to keep going below half your Hit Points maximum."),
        ("Wolfscent", "You gain proficiency in Survival, or a +1 bonus to it if you already have it."),
        ("Unflinching", "Once per Short Rest, you can reroll a saving throw against being Frightened."),
        ("Wide Stance", "Difficult Terrain costs you no extra movement for the first 10 feet you move each turn."),
        ("Thunder in the Chest", "Once per Long Rest, you can shout as a Bonus Action; one creature within 30 feet has Disadvantage on its next attack roll against you."),
    ],
    "Fighter": [
        ("Drilled Footwork", "Your Speed increases by 5 feet while you are wearing armor."),
        ("Weapon Care", "You gain proficiency with one Simple or Martial weapon of your choice."),
        ("Battlefield Read", "You have a +1 bonus to Initiative rolls."),
        ("Set Guard", "Once per Short Rest, you can take the Dodge action as a Bonus Action."),
        ("Second Grip", "You can draw or stow one additional weapon whenever you would draw or stow one."),
        ("Parade Discipline", "You have a +1 bonus to Strength (Athletics) or Charisma (Intimidation) checks; choose when you gain this node."),
    ],
    "Paladin": [
        ("Steady Oath", "You have a +1 bonus to saving throws against being Charmed."),
        ("Polished Plate", "Wearing Medium or Heavy armor no longer imposes Disadvantage on Stealth checks made while standing still."),
        ("Litany Practice", "You gain proficiency in Religion, or a +1 bonus to it if you already have it."),
        ("Shield Arm", "Once per Short Rest, you can add 1 to your AC against one attack roll you can see coming."),
        ("Vigil", "You need only 4 hours of rest to gain the benefit of a Long Rest once per week."),
        ("Radiant Ember", "You can shed Bright Light in a 10-foot radius at will as a Bonus Action."),
    ],
    "Cleric": [
        ("Steady Prayer", "You have a +1 bonus to Wisdom (Insight) checks."),
        ("Consecrated Hands", "Once per Long Rest, you can stabilize a creature at 0 Hit Points as a Bonus Action from 15 feet away."),
        ("Liturgical Memory", "You gain proficiency in History or Religion of your choice."),
        ("Temple Bearing", "You have a +1 bonus to Charisma (Persuasion) checks made with members of a faith you know."),
        ("Warding Word", "Once per Short Rest, a creature within 30 feet gains a +1 bonus to one saving throw."),
        ("Censer Light", "You can produce a floating mote of light within 20 feet at will; it sheds Dim Light in a 10-foot radius."),
    ],
    "Druid": [
        ("Rootsense", "You have a +1 bonus to Wisdom (Survival) checks in natural terrain."),
        ("Green Tongue", "You can exchange simple ideas with Beasts and Plants within 15 feet."),
        ("Weather Skin", "You ignore the effects of Extreme Cold or Extreme Heat, whichever you choose when you gain this node."),
        ("Seed Pouch", "Once per Long Rest, you can cause a plant to grow a day's worth of edible fruit."),
        ("Loam Step", "You leave no tracks in natural terrain unless you choose to."),
        ("Storm Ear", "You have a +1 bonus to Wisdom (Perception) checks made outdoors."),
    ],
    "Ranger": [
        ("Trail Eye", "You have a +1 bonus to Wisdom (Survival) checks made to track."),
        ("Quiet Boots", "You have a +1 bonus to Dexterity (Stealth) checks made in natural terrain."),
        ("Fletcher's Habit", "Once per Long Rest, you can recover half your expended ammunition after a fight instead of half rounded down."),
        ("Field Medicine", "You gain proficiency with a Herbalism Kit."),
        ("Long March", "Your walking Speed increases by 5 feet while you carry no more than half your carrying capacity."),
        ("Beast Read", "You have a +1 bonus to Wisdom (Animal Handling) checks."),
    ],
    "Rogue": [
        ("Light Fingers", "You have a +1 bonus to Dexterity (Sleight of Hand) checks."),
        ("Doorway Sense", "You have a +1 bonus to Intelligence (Investigation) checks made to find a hidden object or mechanism."),
        ("Alley Cant", "You gain proficiency in Deception, or a +1 bonus to it if you already have it."),
        ("Soft Landing", "You take 1 less damage per 10 feet fallen."),
        ("Second Pocket", "Once per Long Rest, a search of your person fails to find one small object you have hidden on you."),
        ("Read the Room", "You have a +1 bonus to Initiative rolls."),
    ],
    "Artificer": [
        ("Tinker's Habit", "You gain proficiency with one type of Artisan's Tools of your choice."),
        ("Spare Parts", "Once per Long Rest, you can repair a broken nonmagical object of Small size or less over 10 minutes."),
        ("Measured Eye", "You have a +1 bonus to Intelligence checks made to appraise or identify an object."),
        ("Safety Catch", "You have a +1 bonus to saving throws against effects caused by your own devices or by traps."),
        ("Lamp Rig", "You can cause a held object to shed Bright Light in a 10-foot radius at will."),
        ("Workbench Memory", "You gain proficiency in Investigation, or a +1 bonus to it if you already have it."),
    ],
    "Wizard": [
        ("Marginalia", "You have a +1 bonus to Intelligence (Arcana) checks."),
        ("Steady Hand", "You have a +1 bonus to saving throws made to maintain Concentration."),
        ("Ink and Salt", "You gain proficiency with a Calligrapher's Supplies."),
        ("Pocket Cantrip", "You learn one cantrip-equivalent trick: you can clean, chill, warm, or mark a Tiny object at a range of 10 feet."),
        ("Reading Light", "You can read in Darkness as if it were Dim Light."),
        ("Cross-Reference", "You have a +1 bonus to Intelligence (History) checks."),
    ],
    "Sorcerer": [
        ("Wellspring Trickle", "You have a +1 bonus to Charisma saving throws."),
        ("Static Skin", "You take 1 less damage from the first source of Lightning or Thunder damage that hits you each Long Rest."),
        ("Blood Hum", "You can sense the presence of active magic within 10 feet of you as a Bonus Action, without knowing its nature."),
        ("Loose Spark", "You can produce a harmless spark, gust, or chime at a range of 15 feet at will."),
        ("Innate Poise", "You have a +1 bonus to Charisma (Performance) checks."),
        ("Overflow", "Once per Long Rest, you can reroll a damage die of 1 on a spell you cast."),
    ],
    "Warlock": [
        ("Whispered Terms", "You have a +1 bonus to Charisma (Deception) checks."),
        ("Borrowed Eyes", "You can see in Dim Light within 30 feet as though it were Bright Light."),
        ("Contract Clause", "Once per Long Rest, you know whether a creature you can see has told you a deliberate lie in the last minute."),
        ("Cold Signature", "You gain proficiency in Arcana, or a +1 bonus to it if you already have it."),
        ("Patron's Ear", "Once per Long Rest, you can send a 10-word message to your patron; a reply is not guaranteed."),
        ("Hollow Step", "You have a +1 bonus to Dexterity (Stealth) checks made in Dim Light or Darkness."),
    ],
    "Bard": [
        ("Perfect Pitch", "You gain proficiency with one Musical Instrument of your choice."),
        ("Crowd Sense", "You have a +1 bonus to Wisdom (Insight) checks made in a group of five or more creatures."),
        ("Turn of Phrase", "You have a +1 bonus to Charisma (Persuasion) checks."),
        ("Traveling Repertoire", "You know one additional language of your choice."),
        ("Cue", "Once per Short Rest, you can give one ally within 30 feet a +1 bonus to one ability check."),
        ("Stagecraft", "You can produce a harmless sound or illusory flourish no larger than 1 foot at will."),
    ],
    "Monk": [
        ("Breath Count", "You can hold your breath for twice as long as normal."),
        ("Quiet Tread", "You have a +1 bonus to Dexterity (Stealth) checks made while unarmored."),
        ("Balance Line", "You have a +1 bonus to Dexterity (Acrobatics) checks."),
        ("Cold Discipline", "You are comfortable in temperatures as low as 0 degrees Fahrenheit without protection."),
        ("Empty Palm", "Once per Short Rest, you can catch a thrown Light object aimed at you with your Reaction."),
        ("Stillness", "You have a +1 bonus to saving throws against being moved against your will."),
    ],
}

# Used for subclass sub-ladders, core filler, and any zone without a pool.
GENERIC_POOL: list[tuple[str, str]] = [
    ("Focused Practice", "You have a +1 bonus to one ability check of your choice, fixed when you gain this node."),
    ("Broadened Training", "You gain proficiency in one skill of your choice."),
    ("Conditioned Wind", "Your walking Speed increases by 5 feet."),
    ("Small Ward", "You reduce the first damage you take each Long Rest by 2."),
    ("Learned Trick", "You gain a cantrip-equivalent utility: you can move a Tiny unattended object up to 10 feet as a Bonus Action."),
    ("Sharp Recall", "You have Advantage on checks made to remember something you personally witnessed."),
    ("Steady Grip", "You have a +1 bonus to checks and saving throws made to avoid dropping what you are holding."),
    ("Watchful Rest", "You remain aware of your surroundings while resting and are not Surprised by an ambush during a rest."),
]

# Training connectors. RAW hands armor and weapon proficiency out with class
# membership; in a free-build tree there is no class to hand it out, and five
# feats in the data (Heavily Armored, Medium/Heavy Armor Master, Shield Master,
# Moderately Armored) have armor-proficiency prerequisites that would otherwise
# be unsatisfiable. These sit in the shared core at martial-facing depth.
TRAINING_CONNECTORS = [
    {
        "key": "light",
        "id": "conn_training_light_armor",
        "name": "Armor Training: Light",
        "effect_summary": "You gain training with Light armor.",
        "depth": 1,
    },
    {
        "key": "shield",
        "id": "conn_training_shields",
        "name": "Armor Training: Shields",
        "effect_summary": "You gain training with Shields.",
        "depth": 1,
    },
    {
        "key": "medium",
        "id": "conn_training_medium_armor",
        "name": "Armor Training: Medium",
        "effect_summary": "You gain training with Medium armor.",
        "depth": 2,
    },
    {
        "key": "heavy",
        "id": "conn_training_heavy_armor",
        "name": "Armor Training: Heavy",
        "effect_summary": "You gain training with Heavy armor.",
        "depth": 3,
    },
]


def _pool_entry(pool: list[tuple[str, str]], index: int) -> tuple[str, str]:
    name, effect = pool[index % len(pool)]
    repeat = index // len(pool)
    if repeat:
        name = f"{name} {repeat + 1}"
    return name, effect


def make_connector(
    node_id: str,
    name: str,
    effect_summary: str,
    zone: str,
    depth: float,
    *,
    is_spine: bool = False,
    is_gate: bool = False,
    subregion: str | None = None,
    role: str = "connector",
) -> dict:
    return {
        "id": node_id,
        "name": name,
        "type": "connector",
        "role": role,
        "source_book": None,
        "generated": True,
        "is_spine": is_spine,
        "is_gate": is_gate,
        "zone": zone,
        "subregion": subregion,
        "depth": depth,
        "point_cost": config.FLAT_POINT_COST,
        "tags": ["connector"] + (["gate"] if is_gate else []),
        "effect_summary": effect_summary,
        "mechanical_data": {},
        "prereqs_raw": [],
    }


def zone_ladder_rung(zone: str, level: int, index: int | None = None) -> dict:
    pool = ZONE_POOL.get(zone, GENERIC_POOL)
    name, effect = _pool_entry(pool, index if index is not None else level - 1)
    return make_connector(
        f"conn_{zone.lower()}_rung_{level}",
        f"{zone} Path: {name}",
        effect,
        zone,
        float(level),
        is_spine=True,
        role="zone_ladder",
    )


def subclass_rung(zone: str, subclass: str, level: int, index: int) -> dict:
    name, effect = _pool_entry(GENERIC_POOL, index)
    slug = subclass.lower().replace(" ", "_").replace("'", "")
    return make_connector(
        f"conn_{zone.lower()}_{slug}_rung_{level}",
        f"{subclass} Study: {name}",
        effect,
        zone,
        float(level),
        is_spine=True,
        subregion=subclass,
        role="subclass_ladder",
    )


def gate_node(zone: str) -> dict:
    return make_connector(
        f"gate_{zone.lower()}",
        f"{zone} Gate",
        f"The boundary marker of the {zone} board. Purchasing it opens the "
        f"{zone} zone for allocation; until then that board stays closed.",
        zone,
        float(config.DEPTH_GATE),
        is_spine=True,
        is_gate=True,
        role="gate",
    )


def hub_node() -> dict:
    return make_connector(
        "conn_core_hub",
        "The Commons",
        "Where every character starts. It grants nothing on its own and costs "
        "no points; every path in the tree traces back to it.",
        config.CORE_ZONE,
        float(config.DEPTH_HUB),
        is_spine=True,
        role="hub",
    )


def core_connectors() -> list[dict]:
    nodes = []
    for index in range(4):
        name, effect = _pool_entry(GENERIC_POOL, index)
        nodes.append(
            make_connector(
                f"conn_core_{index + 1}",
                f"Common Ground: {name}",
                effect,
                config.CORE_ZONE,
                1.0,
                is_spine=True,
                role="core",
            )
        )
    for spec in TRAINING_CONNECTORS:
        nodes.append(
            make_connector(
                spec["id"],
                spec["name"],
                spec["effect_summary"],
                config.CORE_ZONE,
                float(spec["depth"]),
                role="training",
            )
        )
    return nodes


def martial_commons(boundary_key: str, depth: float, index: int) -> dict:
    name, effect = _pool_entry(GENERIC_POOL, index + 3)
    return make_connector(
        f"conn_commons_{boundary_key}",
        f"Drill Ground: {name}",
        effect,
        config.CORE_ZONE,
        depth,
        role="commons",
    )
