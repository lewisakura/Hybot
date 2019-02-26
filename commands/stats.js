const config = require('../env');
const Command = require('../Command');

module.exports = class Stats extends Command {
	constructor() {
		super();
		this.name = 'stats';
		this.group = 'Utility';
		this.description = 'Shows statistics';
	}

	async execute(ctx) {
		await ctx.say({
			embed: {
				title: 'Statistics',
				description: `Servers: ${ctx.client.guilds.size}
Unique users: ${ctx.client.users.size}`
			}
		});
	}
};
