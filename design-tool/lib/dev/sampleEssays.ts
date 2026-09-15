// Pilot demo essays for the AP Seminar-style free-response prompt used in the
// 2026-09-17 pilot sittings (docs/scoring-corpus-design.md §Progress).
//
// WHY THESE EXIST: the "Score with AI" path (finding R-4) has never run
// against Bedrock on the deployed origin, and proving it needs several
// submitted essays of DELIBERATELY different quality — high, middling, weak,
// a two-sentence non-answer and a fluent off-topic one. Producing those
// through the macOS client would mean five real sittings; `seed-essays`
// writes them straight into the attempt tables instead.
//
// The prompt they answer: read four sources, identify a theme that connects
// them, and write an argument presenting your own perspective, incorporating
// at least two of the sources and referring to them as Source A-D or by
// author.
//
//   Source A  Robert Frost, "The Road Not Taken" (1915)
//   Source B  Anant Agarwal, Forbes (2018), "Why Today's Professionals Are
//             Taking the Career Road Less Traveled" — nonlinear careers,
//             lifelong learning, innovators
//   Source C  OECD (2025), "The State of Global Teenage Career Preparation" —
//             PISA data: teenagers' expectations concentrated in a handful of
//             jobs, misaligned with their education, and the value of career
//             guidance
//   Source D  Barbara Bush, Wellesley commencement address (1990) — find your
//             own passion, relationships over career
//
// The rubric they are written against scores four rows at 0/2/4/6 each:
// establishes a perspective connecting the sources; sustains a logical line of
// reasoning with commentary; synthesises at least two sources accurately;
// conventions and attribution.
//
// Nothing here is a real student's work — every essay is written for this
// fixture. The weaknesses in `low`, `brief` and `offtopic` are deliberate;
// do not "fix" the grammar.

export const ESSAY_QUALITIES = ["high", "mid", "low", "brief", "offtopic"] as const;
export type EssayQuality = (typeof ESSAY_QUALITIES)[number];

export function isEssayQuality(value: string): value is EssayQuality {
  return (ESSAY_QUALITIES as readonly string[]).includes(value);
}

export type SampleEssay = { title: string; text: string };

export const SAMPLE_ESSAYS: Record<EssayQuality, SampleEssay> = {
  // ~450 words. A perspective that is nobody's source in particular, three
  // sources synthesised with commentary, clean prose, correct attribution.
  high: {
    title: "The road is built, not found",
    text: [
      "Frost's traveller in Source A stands at a fork and, years later, tells the story as though the choice explained everything about him. What the poem actually shows is a man who admits the two roads were \"really about the same\" and who expects to retell the moment \"with a sigh\" anyway. Read beside Sources B and C, that admission is the most useful thing in the poem: the road a person ends up on is built out of ordinary decisions and the information available when they make them, not discovered in a single dramatic moment. My own perspective is that the difference between a life that looks chosen and one that merely happened is not courage at the fork. It is how much a person knows about the woods.",
      "Source B makes the optimistic version of this argument. Agarwal describes professionals moving sideways, retraining, and stitching together careers that have no single title, and he treats the willingness to keep learning as the skill that makes those moves survivable. He is describing people who already have the map. They know which credentials transfer, which industries are hiring, and what a lateral move costs. For them the road less travelled is a calculated risk rather than a gamble, and Agarwal is right that it can produce innovators.",
      "Source C is where that optimism meets its limit. The OECD's PISA data show teenagers' career expectations crowding into a small handful of well-known occupations, and it shows those expectations sitting badly next to the courses students are actually taking. Teenagers are not refusing the road less travelled out of timidity. They cannot see it. A student who names one of ten famous jobs is not choosing at a fork at all; they are naming the only path they have been shown. The OECD's conclusion that career guidance changes outcomes follows directly, and it reframes Frost: the traveller could at least see both roads.",
      "Bush's advice in Source D, to find your own passion and to guard relationships against the demands of a career, is easy to read as a rejection of all this planning. I think it is a correction to it. She is warning against a life organised entirely around a job title, which is exactly the failure mode Source C measures when students compress their futures into ten occupations. Passion without information produces disappointment; information without passion produces a competent life nobody wanted.",
      "Taken together, the sources argue for a less romantic account of choice than the one the poem is usually quoted to support. The road less travelled is not a virtue in itself. It becomes one when a person can actually see where the roads go, has learned enough to change course when they were wrong, and has kept the relationships that make a wrong turn survivable.",
    ].join("\n\n"),
  },

  // ~300 words. Identifies the theme, two sources used accurately but mostly
  // summarised, commentary thin, organisation wobbles.
  mid: {
    title: "Different paths",
    text: [
      "All four sources are about the choices people make about their future and their careers. Source A is a poem about a traveler who comes to two roads and takes the one that was less traveled by, and he says that this made all the difference. Source B is an article about how careers today are not a straight line anymore. Source C is a report with data about teenagers and what jobs they expect to have. My perspective is that people should be open to taking a different path, but they also need real information before they can do that.",
      "Source B by Agarwal explains that professionals now change directions many times and that they have to keep learning new things throughout their lives. He says the people who do this end up being innovators. This supports the idea that the less traveled road can work out, because the article gives examples of people who left one field and did well in another. It shows that a career is not one decision.",
      "Source C shows a problem with this. The OECD found that teenagers expect to work in only a small number of jobs, and that what they expect does not always match the classes they are taking. So a lot of teenagers are not really choosing. They are just picking the jobs they have heard of. The report says career guidance helps, which makes sense because you cannot choose something you do not know exists.",
      "Frost's poem is also interesting because the traveler admits the roads were about the same but he still says his choice made all the difference later. This might mean people tell a story about their choices afterwards.",
      "In conclusion, the sources show that taking a different path can be a good thing, but only if students actually know what their options are. Schools should give students more information so they can make a real choice instead of guessing.",
    ].join("\n\n"),
  },

  // ~200 words. Vague theme, one source, misreads Frost, several errors left
  // in on purpose.
  low: {
    title: "Be different",
    text: [
      "The theme of these sources is that you should be yourself and not follow the crowd. In Source A the poem says to take the road less traveled by, which means you should be different from everybody else and not do what everyone is doing. That is the main idea and the other sources agree with it to.",
      "The poem is about a guy in the woods who has to pick a road. He picks the one that nobody walks on and it made all the difference in his life, so he was happy about it. This shows that being different is better than being normal. Alot of people just follow there friends and end up not happy with there job.",
      "Careers are also like this because you can pick a job that is unusual instead of a boring one. If you do what you love then you will be sucessful. Some people go to college for something they dont even like and then they waste there time.",
      "In conclusion the sources are saying be different and take your own road. I agree with this because everyone is a individual and should make there own choices about there life and there future.",
    ].join("\n\n"),
  },

  // ~60 words. Two sentences, one source named, no argument.
  brief: {
    title: "Short answer",
    text: "Source A is a poem by Robert Frost about picking between two roads in the woods and taking the one that not as many people took, which he says made all the difference for him. I think the theme of the sources is that everybody has to make their own choices about their career and their future and nobody can make that choice for them.",
  },

  // ~150 words. Fluent, organised, and about something else entirely. No
  // sources.
  offtopic: {
    title: "The lunch problem",
    text: [
      "The lunch schedule at this school needs to change. Right now we have three lunch periods and the last one does not start until almost two o'clock, which means some students go from breakfast until the middle of the afternoon without eating anything. That is a long time to sit through four classes and still be expected to pay attention in all of them.",
      "The line is the other problem. There are two serving windows for the entire building, so by the time the people at the back of the line get their food they have about eight minutes left to eat it. Most of them give up and buy chips instead, which is not a real lunch by anyone's definition.",
      "Opening the second cafeteria and moving third lunch thirty minutes earlier would fix both problems without costing the district anything. Students would eat, and teachers would stop competing with hunger for our attention in sixth period.",
    ].join("\n\n"),
  },
};
