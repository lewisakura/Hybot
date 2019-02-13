const Eris = require('eris'),
	CatLoggr = require('cat-loggr'),
	MongoDB = require('mongodb'),
	fs = require('fs'),
	Promise = require('bluebird'),
	config = require('./config.json'),
	bot = new Eris(config.token),
	loggr = new CatLoggr();

require('eris-additions')(Eris); // as the name implies, it adds things to eris

const commands = {};
const hooks = {};

global.Promise = Promise;

Promise.promisifyAll(fs);
Promise.promisifyAll(MongoDB);

loggr.setGlobal();

let db;
let conn;

bot.on('ready', () => {
	console.info('Hello world!');
});

(async () => {
	for (const logoLine of config.logo) console.init(logoLine);

	console.init('Connecting to MongoDB...');

	try {
		conn = await MongoDB.connectAsync(
			'mongodb://' + config.mongodb.host + ':' + config.mongodb.port,
			{useNewUrlParser: true}
		);
		db = conn.db(config.mongodb.db);
		console.info('OK');
	} catch (e) {
		console.error(e);
		return;
	}

	console.init('Loading commands...');

	const cmds = (await fs.readdirAsync('./commands')).filter(
		file =>
			!file.startsWith('#') && !file.startsWith('.#') && file.endsWith('.js')
	);
	const hookContext = {bot, db, client: bot};

	for (const file of cmds) {
		const Command = require('./commands/' + file);
		const name = file.substring(0, file.length - 3);
		const cmd = new Command();
		if (cmd.hooks) {
			hooks[name] = {};
			for (const hookName in cmd.hooks) {
				// We need to give them a context-like object, we store them on this object so that we can unload in the future
				hooks[name][hookName] = cmd.hooks[hookName].bind(cmd, hookContext);
				if (hookName == 'loaded') {
					if (bot.startTime) {
						hooks[name][hookName]();
					} else {
						bot.once('ready', hooks[name][hookName]);
					}
				} else {
					bot.on(hookName, hooks[name][hookName]);
				}
			}
		}

		commands[name] = cmd;

		console.info("Loaded command '" + name + "'");
	}

	console.init('OK');

	console.init('Connecting to Discord now.');

	bot.connect();

	bot.on('guildMemberAdd', async (guild, member) => {
		const guildInfo = await getGuildData(msg.channel.guild.id);

		// welcomer
		if (guildInfo.welcomer.enabled) {
			const formattedString = guildInfo.welcomer.message
				.replace('{user}', member.username)
				.replace('{server}', guild.name);

			try {
				await guild.channels
					.find(chan => chan.id === guildInfo.welcomer.channel)
					.createMessage(formattedString);
			} catch (e) {
				console.warn(
					'Channel in guild using welcomer does not exist. Disabling.'
				);
				await db
					.collection('guild')
					.updateOne(guildInfo, {$set: {welcomer: {enabled: false}}});
			}
		}
	});

	bot.on('messageCreate', async msg => {
		if (msg.author.bot) return;

		const guildInfo = await getGuildData(msg.channel.guild.id);

		var justAfk = false;

		for (let afk of guildInfo.afk) {
			if (msg.author.id === afk.id) {
				let guild = db.collection('guild');

				await guild.updateOne(
					{guildId: msg.channel.guild.id},
					{
						$set: {afk: guildInfo.afk.filter(v => v.id !== msg.author.id)}
					}
				);

				await msg.channel.createMessage(
					'Welcome back, <@' + msg.author.id + '>!'
				);

				justAfk = true;
			} else if (msg.mentions.length > 0) {
				for (let mention of msg.mentions) {
					if (mention.id === afk.id) {
						await msg.channel.createMessage(
							mention.username + ' is currently AFK: ' + afk.message
						);
					}
				}
			}
		}

		if (msg.content.startsWith(guildInfo.prefix)) {
			if (guildInfo.ignored.users.includes(msg.author.id)) return;

			for (let role in msg.member.roles) {
				if (guildInfo.ignored.roles.includes(role.id)) return;
			}

			if (guildInfo.ignored.channels.includes(msg.channel.id)) return;

			// developer's note: this is how to not break everything when someone sets a prefix with spaces in
			const fixedContent = msg.content.substring(guildInfo.prefix.length);
			const args = fixedContent.split(' ');
			const command = args.shift();

			if (commands[command] !== undefined) {
				console.info('Checking permissions for command ' + command + '.');

				const permissionsMissing = commands[command].checkPermissions(
					msg.member,
					bot
				);

				if (
					permissionsMissing.user.length > 0 ||
					permissionsMissing.bot.length > 0
				) {
					if (permissionsMissing.user.length > 0) {
						await msg.channel.createMessage({
							embed: {
								title: ':x: Permissions Error',
								description:
									'You are missing the following permissions:\n`' +
									permissionsMissing.user.join('`\n`') +
									'`'
							}
						});
					} else if (permissionsMissing.bot.length > 0) {
						await msg.channel.createMessage({
							embed: {
								title: ':x: Permissions Error',
								description:
									'I am missing the following permissions:\n' +
									permissionsMissing.bot.join('`\n`') +
									'`'
							}
						});
					}
					return;
				}

				console.info('Executing command ' + command + '.');
				// context object contains literally everything
				await commands[command].execute({
					bot,
					client: bot,
					msg,
					args,
					fixedContent,
					commands,
					db,
					loggr,
					guildInfo,
					guild: msg.guild,
					justAfk,
					async say(content, args) {
						if (content.embed && !content.embed.color)
							content.embed.color = guildInfo.theme;
						return await msg.channel.createMessage(content, args);
					},
					async ask(content, filter, wholeMessage) {
						await msg.channel.createMessage(content);
						const results = await msg.channel.awaitMessages(
							// Filter is a bit more than a filter, it may also respond to the user's invalid data
							message => {
								if (message.author.id != msg.author.id) {
									console.log('Bad author');
									return false;
								}
								if (filter) {
									return filter(message);
								} else {
									return true;
								}
							},
							{
								maxMatches: 1,
								// 1 minute is plenty
								time: 60000
							}
						);
						if (!results.length) {
							await this.say("You didn't give a response!");
							throw new Error('NO_AWAIT_MESSAGES_RESPONSE');
						}
						return wholeMessage ? results[0] : results[0] && results[0].content;
					}
				});
			}
		}
	});
})();

async function getGuildData(id) {
	const guildData = db.collection('guild');

	var guildInfo = await guildData.findOne({guildId: id});

	if (guildInfo === null) {
		await guildData.insertOne(
			(guildInfo = {
				guildId: id,
				welcomer: {
					enabled: false,
					channel: null,
					message: 'Welcome, {user}, to {server}!'
				},
				farewell: {
					enabled: false,
					channel: null,
					message: 'Farewell, {user}.'
				},
				ignored: {
					roles: [],
					users: [],
					channels: []
				},
				theme: config.theme,
				prefix: config.prefix,
				afk: []
			})
		);
	}

	return guildInfo;
}

process.on('unhandledRejection', function(err) {
	throw err;
});

Object.defineProperty(Array.prototype, 'chunk', {
	value(n) {
		return Array(Math.ceil(this.length / n))
			.fill()
			.map((_, i) => this.slice(i * n, i * n + n));
	}
});

Object.defineProperty(Array.prototype, 'diff', {
	value(a) {
		return {
			added: this.filter(i => !a.includes(i)),
			removed: a.filter(i => !this.includes(i))
		};
	}
});

module.exports = {client: bot, bot, db, conn, commands, hooks};
