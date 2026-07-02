import express, { Request, Response, NextFunction } from 'express';
import { Client, Permissions } from 'discord.js-selfbot-v13';
import path from 'path';

const fetch = require('node-fetch') as typeof import('node-fetch').default;
const archiver = require('archiver');
const FormData = require('form-data');

const app = express();
const PORT = 3000;

process.on('unhandledRejection', (reason: any) => {
    console.error('promise rejeitada sem tratamento:', reason);
});

process.on('uncaughtException', (err: any) => {
    console.error('excecao nao tratada:', err);
});

function createDiscordClient(res?: Response) {
    const client = new Client();
    client.on('error', (err: any) => {
        console.error('erro no client discord:', err);
        if (res && !res.writableEnded) {
            log(res, 'erro de conexao com discord: ' + (err?.message || String(err)), 'error');
        }
    });
    return client;
}

app.use(express.json());
app.use('/styles', express.static(path.join(process.cwd(), 'src/styles')));
app.use('/image', express.static(path.join(process.cwd(), 'src/image')));
app.use('/pages', express.static(path.join(process.cwd(), 'src/pages')));

app.get('/', (_req: Request, res: Response) => {
    res.redirect('/pages/login.html');
});

app.get('/login', (_req: Request, res: Response) => {
    res.redirect('/pages/login.html');
});

interface AuthRequest extends Request {
    token?: string;
}

function verifyToken(req: AuthRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.redirect('/pages/erro.html');
    }
    req.token = authHeader.slice(7);
    next();
}

async function getDiscordUser(token: string) {
    const response = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: token },
    });
    if (!response.ok) throw new Error('token invalido');
    return response.json();
}

async function getGuilds(token: string) {
    const response = await fetch('https://discord.com/api/v10/users/@me/guilds', {
        headers: { Authorization: token },
    });
    if (!response.ok) throw new Error('falha ao obter servidores');
    return response.json();
}

app.post('/api/login', async (req: Request, res: Response) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'token nao fornecido' });
        const user = await getDiscordUser(token);
        res.json({ success: true, user });
    } catch {
        res.status(401).json({ error: 'token invalido' });
    }
});

app.get('/api/servers', verifyToken, async (req: AuthRequest, res: Response) => {
    try {
        const guilds = await getGuilds(req.token!) as any[];
        const MANAGE_GUILD = BigInt(0x20);
        const servers = guilds.map((guild: any) => ({
            id: guild.id,
            name: guild.name,
            icon: guild.icon
                ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
                : null,
            hasAccess: (BigInt(guild.permissions) & MANAGE_GUILD) === MANAGE_GUILD,
        }));
        res.json({ servers });
    } catch {
        res.status(500).json({ error: 'erro ao carregar servidores' });
    }
});

function send(res: Response, type: string, payload: object) {
    res.write(JSON.stringify({ type, ...payload }) + '\n');
}

function log(res: Response, msg: string, level: string = 'info') {
    send(res, 'log', { msg, level });
}

function progress(res: Response, text: string, pct: number, stage: string) {
    send(res, 'progress', { text, pct, stage });
}

async function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

async function buildZip(type: 'emojis' | 'stickers', guild: any): Promise<Buffer> {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];

    const done = new Promise<Buffer>((resolve, reject) => {
        archive.on('data', (chunk: Buffer) => chunks.push(chunk));
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        archive.on('error', (err: any) => reject(err));
    });

    if (type === 'emojis') {
        const emojis = [...guild.emojis.cache.values()];
        for (const emoji of emojis) {
            try {
                const e = emoji as any;
                const buf = await fetch(e.url).then((r: any) => r.buffer());
                const ext = e.animated ? 'gif' : 'png';
                archive.append(buf, { name: `${e.name}.${ext}` });
            } catch {}
        }
    } else {
        const stickers = await guild.stickers.fetch();
        for (const sticker of stickers.values()) {
            try {
                const s = sticker as any;
                const buf = await fetch(s.url).then((r: any) => r.buffer());
                const ext = s.format === 'LOTTIE' ? 'json' : s.format === 'GIF' ? 'gif' : 'png';
                archive.append(buf, { name: `${s.name}.${ext}` });
            } catch {}
        }
    }

    await archive.finalize();
    return done;
}

async function part1_renameAndIcon(res: Response, origin: any, destination: any) {
    log(res, 'iniciando parte 1: nome e icone do servidor', 'step');
    progress(res, 'parte 1 de 3', 5, 'nome e icone');

    try {
        const oldName = destination.name;
        await destination.setName(origin.name);
        log(res, `nome alterado: "${oldName}" -> "${origin.name}"`, 'add');
    } catch (e: any) {
        log(res, 'erro ao alterar nome: ' + e.message, 'error');
    }

    try {
        const iconUrl = origin.iconURL({ format: 'png', size: 1024 });
        if (iconUrl) {
            const buf = await fetch(iconUrl).then((r: any) => r.buffer());
            await destination.setIcon(buf);
            log(res, 'icone do servidor copiado', 'add');
        } else {
            log(res, 'servidor de origem sem icone, pulando', 'warn');
        }
    } catch (e: any) {
        log(res, 'erro ao copiar icone: ' + e.message, 'error');
    }

    try {
        const bannerUrl = origin.bannerURL({ format: 'png', size: 1024 });
        if (bannerUrl) {
            const buf = await fetch(bannerUrl).then((r: any) => r.buffer());
            await destination.setBanner(buf);
            log(res, 'banner do servidor copiado', 'add');
        } else {
            log(res, 'servidor de origem sem banner, pulando', 'warn');
        }
    } catch (e: any) {
        log(res, 'erro ao copiar banner: ' + e.message, 'error');
    }

    progress(res, 'parte 1 concluida', 33, 'nome e icone ok');
    log(res, 'parte 1 finalizada', 'ok');
}

async function part2_deleteAll(res: Response, destination: any) {
    log(res, 'iniciando parte 2: limpeza do servidor de destino', 'step');
    progress(res, 'parte 2 de 3', 35, 'limpando destino');

    const channels = [...destination.channels.cache.values()];
    let deleted = 0;

    for (const ch of channels) {
        try {
            await (ch as any).delete();
            deleted++;
            log(res, `canal deletado: ${(ch as any).name}`, 'remove');
            await sleep(300);
        } catch (e: any) {
            log(res, `erro ao deletar canal ${(ch as any).name}: ` + e.message, 'error');
        }
    }

    log(res, `${deleted} canal(ais) deletado(s)`, 'info');
    progress(res, 'canais removidos', 48, 'removendo cargos');

    const roles = [...destination.roles.cache.values()].filter(
        (r: any) => !r.managed && r.name !== '@everyone'
    );
    for (const role of roles) {
        try {
            await (role as any).delete();
            log(res, `cargo deletado: ${(role as any).name}`, 'remove');
            await sleep(200);
        } catch (e: any) {
            log(res, `erro ao deletar cargo ${(role as any).name}: ` + e.message, 'error');
        }
    }
    log(res, `${roles.length} cargo(s) deletado(s)`, 'info');
    progress(res, 'cargos removidos', 56, 'removendo emojis');

    const emojis = [...destination.emojis.cache.values()];
    for (const emoji of emojis) {
        try {
            await (emoji as any).delete();
            log(res, `emoji deletado: ${(emoji as any).name}`, 'remove');
            await sleep(200);
        } catch (e: any) {
            log(res, `erro ao deletar emoji ${(emoji as any).name}: ` + e.message, 'error');
        }
    }
    log(res, `${emojis.length} emoji(s) deletado(s)`, 'info');
    progress(res, 'emojis removidos', 62, 'removendo figurinhas');

    try {
        const stickers = await destination.stickers.fetch();
        for (const sticker of stickers.values()) {
            try {
                await (sticker as any).delete();
                log(res, `figurinha deletada: ${(sticker as any).name}`, 'remove');
                await sleep(300);
            } catch (e: any) {
                log(res, `erro ao deletar figurinha ${(sticker as any).name}: ` + e.message, 'error');
            }
        }
        log(res, `${stickers.size} figurinha(s) deletada(s)`, 'info');
    } catch (e: any) {
        log(res, 'erro ao buscar figurinhas: ' + e.message, 'error');
    }

    progress(res, 'parte 2 concluida', 66, 'limpeza ok');
    log(res, 'parte 2 finalizada', 'ok');
}

function mapOverwrites(res: Response, ch: any, roleIdMap: Map<string, string>) {
    const overwrites: any[] = [];
    for (const ow of ch.permissionOverwrites.cache.values()) {
        if (ow.type === 'member') continue;
        const mappedId = roleIdMap.get(ow.id);
        if (!mappedId) {
            log(res, `aviso: permissao de cargo nao encontrada em "${ch.name}", ignorada`, 'warn');
            continue;
        }
        overwrites.push({ id: mappedId, allow: ow.allow, deny: ow.deny, type: 'role' });
    }
    return overwrites;
}

async function part3_cloneContent(res: Response, origin: any, destination: any) {
    log(res, 'iniciando parte 3: criando estrutura do servidor de origem', 'step');
    progress(res, 'parte 3 de 3', 68, 'criando cargos');

    const roleIdMap = new Map<string, string>();
    roleIdMap.set(origin.id, destination.id);

    const roles = [...origin.roles.cache.values()]
        .filter((r: any) => !r.managed && r.name !== '@everyone')
        .sort((a: any, b: any) => b.position - a.position);

    for (const role of roles) {
        try {
            const newRole = await destination.roles.create({
                name: role.name,
                color: role.color,
                hoist: role.hoist,
                permissions: role.permissions,
                mentionable: role.mentionable,
                position: role.position,
            });
            roleIdMap.set(role.id, newRole.id);
            log(res, `cargo criado: ${role.name}`, 'add');
            await sleep(300);
        } catch (e: any) {
            log(res, `erro ao criar cargo ${role.name}: ` + e.message, 'error');
        }
    }
    log(res, `${roles.length} cargo(s) criado(s)`, 'info');
    progress(res, 'cargos criados', 76, 'criando categorias');

    const threadTypes = ['GUILD_NEWS_THREAD', 'GUILD_PUBLIC_THREAD', 'GUILD_PRIVATE_THREAD'];
    const allChannels = [...origin.channels.cache.values()]
        .filter((ch: any) => !threadTypes.includes(ch.type))
        .sort((a: any, b: any) => a.position - b.position);
    const created = new Map<string, any>();
    const destinationIsCommunity = destination.features.includes('COMMUNITY');

    const categories = allChannels.filter((ch: any) => ch.type === 'GUILD_CATEGORY');
    for (const ch of categories) {
        try {
            const cat = await destination.channels.create(ch.name, {
                type: 'GUILD_CATEGORY',
                position: ch.position,
                permissionOverwrites: mapOverwrites(res, ch, roleIdMap),
            });
            created.set(ch.id, cat);
            log(res, `categoria criada: ${ch.name}`, 'add');
            await sleep(300);
        } catch (e: any) {
            log(res, `erro ao criar categoria ${ch.name}: ` + e.message, 'error');
        }
    }
    log(res, `${categories.length} categoria(s) criada(s)`, 'info');
    progress(res, 'categorias criadas', 84, 'criando canais');

    const textVoice = allChannels.filter((ch: any) => ch.type !== 'GUILD_CATEGORY');
    let channelsCreated = 0;
    for (const ch of textVoice) {
        const parent = created.get(ch.parentId);
        const overwrites = mapOverwrites(res, ch, roleIdMap);

        let channelType = ch.type;
        if (channelType === 'GUILD_NEWS' && !destinationIsCommunity) {
            channelType = 'GUILD_TEXT';
            log(res, `aviso: destino nao e servidor comunidade, "${ch.name}" criado como texto normal`, 'warn');
        }

        const opts: any = {
            type: channelType,
            position: ch.position,
            parent: parent ? parent.id : undefined,
            permissionOverwrites: overwrites,
        };

        if (channelType === 'GUILD_TEXT' || channelType === 'GUILD_NEWS' || channelType === 'GUILD_FORUM' || channelType === 'GUILD_MEDIA') {
            opts.topic = ch.topic || undefined;
            opts.nsfw = ch.nsfw;
            opts.rateLimitPerUser = ch.rateLimitPerUser;
        }
        if (channelType === 'GUILD_VOICE' || channelType === 'GUILD_STAGE_VOICE') {
            opts.bitrate = ch.bitrate;
            opts.userLimit = ch.userLimit;
            opts.rtcRegion = ch.rtcRegion || undefined;
        }
        if (channelType === 'GUILD_FORUM' || channelType === 'GUILD_MEDIA') {
            opts.defaultSortOrder = ch.defaultSortOrder ?? undefined;
            opts.defaultForumLayout = ch.defaultForumLayout ?? undefined;
            opts.defaultThreadRateLimitPerUser = ch.defaultThreadRateLimitPerUser ?? undefined;
            if (ch.availableTags?.length) {
                log(res, `aviso: tags do forum "${ch.name}" nao foram clonadas`, 'warn');
            }
        }

        try {
            await destination.channels.create(ch.name, opts);
            channelsCreated++;
            log(res, `canal criado: ${ch.name} (${channelType})`, 'add');
            await sleep(300);
        } catch (e: any) {
            log(res, `erro ao criar canal ${ch.name}: ` + e.message, 'error');
        }
    }
    log(res, `${channelsCreated} de ${textVoice.length} canal(ais) criado(s)`, 'info');
    progress(res, 'canais criados', 90, 'copiando emojis');

    const emojis = [...origin.emojis.cache.values()];
    for (const emoji of emojis) {
        try {
            const buf = await fetch((emoji as any).url).then((r: any) => r.buffer());
            await destination.emojis.create(buf, (emoji as any).name);
            log(res, `emoji copiado: ${(emoji as any).name}`, 'add');
            await sleep(300);
        } catch (e: any) {
            log(res, `erro ao copiar emoji ${(emoji as any).name}: ` + e.message, 'error');
        }
    }
    log(res, `${emojis.length} emoji(s) copiado(s)`, 'info');
    progress(res, 'emojis copiados', 95, 'copiando figurinhas');

    try {
        const stickers = await origin.stickers.fetch();
        for (const sticker of stickers.values()) {
            try {
                const s = sticker as any;
                const buf = await fetch(s.url).then((r: any) => r.buffer());
                const tags = Array.isArray(s.tags) ? s.tags.join(',') : (s.tags || '');
                await destination.stickers.create(buf, s.name, tags, {
                    description: s.description,
                });
                log(res, `figurinha copiada: ${s.name}`, 'add');
                await sleep(300);
            } catch (e: any) {
                log(res, `erro ao copiar figurinha ${(sticker as any).name}: ` + e.message, 'error');
            }
        }
        log(res, `${stickers.size} figurinha(s) copiada(s)`, 'info');
    } catch (e: any) {
        log(res, 'erro ao buscar figurinhas da origem: ' + e.message, 'error');
    }

    progress(res, 'parte 3 concluida', 100, 'finalizado');
    log(res, 'parte 3 finalizada', 'ok');
}

app.post('/api/clone', verifyToken, async (req: AuthRequest, res: Response) => {
    const { originId, destinationId } = req.body as { originId: string; destinationId: string };

    if (!originId || !destinationId) {
        return res.status(400).json({ error: 'ids do servidor nao fornecidos' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();

    const client = createDiscordClient(res);

    try {
        log(res, 'conectando ao discord...', 'info');
        await client.login(req.token!);
        log(res, 'conectado com sucesso', 'ok');

        const originGuild = await client.guilds.fetch(originId);
        const destinationGuild = await client.guilds.fetch(destinationId);

        log(res, `origem: ${originGuild.name}`, 'info');
        log(res, `destino: ${destinationGuild.name}`, 'info');

        log(res, 'carregando dados completos dos servidores...', 'info');
        await Promise.all([
            originGuild.channels.fetch(),
            originGuild.roles.fetch(),
            originGuild.emojis.fetch(),
            destinationGuild.channels.fetch(),
            destinationGuild.roles.fetch(),
            destinationGuild.emojis.fetch(),
        ]);
        log(res, 'dados carregados', 'ok');

        const botMember = await destinationGuild.members.fetchMe();

        if (
            !botMember.permissions.has(Permissions.FLAGS.MANAGE_CHANNELS) ||
            !botMember.permissions.has(Permissions.FLAGS.MANAGE_ROLES) ||
            !botMember.permissions.has(Permissions.FLAGS.MANAGE_EMOJIS_AND_STICKERS)
        ) {
            throw new Error('permissoes insuficientes no servidor de destino');
        }

        log(res, 'permissoes verificadas', 'ok');

        await part1_renameAndIcon(res, originGuild, destinationGuild);
        await part2_deleteAll(res, destinationGuild);
        await part3_cloneContent(res, originGuild, destinationGuild);

        send(res, 'done', { msg: 'clonagem concluida com sucesso' });
    } catch (error: any) {
        console.error('erro em /api/clone:', error);
        log(res, 'erro fatal: ' + (error?.message || String(error)), 'error');
        send(res, 'error', { msg: error?.message || String(error) });
    } finally {
        client.destroy();
        res.end();
    }
});

app.post('/api/webhook-zip', verifyToken, async (req: AuthRequest, res: Response) => {
    const { serverId, type, webhookUrl } = req.body as { serverId: string; type: 'emojis' | 'stickers'; webhookUrl: string };

    if (!serverId || (type !== 'emojis' && type !== 'stickers') || !webhookUrl) {
        return res.status(400).json({ error: 'dados nao fornecidos' });
    }

    if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
        return res.status(400).json({ error: 'url de webhook invalida' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();

    const client = createDiscordClient(res);

    try {
        log(res, 'conectando ao discord...', 'info');
        await client.login(req.token!);

        const guild = await client.guilds.fetch(serverId);
        log(res, `servidor: ${guild.name}`, 'info');
        log(res, `gerando zip de ${type}...`, 'step');

        const zipBuffer = await buildZip(type, guild);
        log(res, `zip gerado: ${(zipBuffer.length / 1024).toFixed(1)} kb`, 'ok');

        const form = new FormData();
        form.append('payload_json', JSON.stringify({
            username: guild.name,
            avatar_url: guild.iconURL() || undefined,
        }));
        form.append('file', zipBuffer, {
            filename: `${guild.name}-${type}.zip`,
            contentType: 'application/zip',
        });

        log(res, 'enviando zip via webhook...', 'step');

        const webhookRes = await fetch(webhookUrl, {
            method: 'POST',
            body: form as any,
            headers: form.getHeaders(),
        });

        if (!webhookRes.ok) {
            const errText = await webhookRes.text();
            throw new Error('webhook retornou erro ' + webhookRes.status + ': ' + errText);
        }

        log(res, 'zip enviado com sucesso via webhook', 'ok');
        send(res, 'done', { msg: 'zip enviado com sucesso' });
    } catch (error: any) {
        console.error('erro em /api/webhook-zip:', error);
        log(res, 'erro fatal: ' + (error?.message || String(error)), 'error');
        send(res, 'error', { msg: error?.message || String(error) });
    } finally {
        client.destroy();
        res.end();
    }
});

app.post('/api/download-zip', verifyToken, async (req: AuthRequest, res: Response) => {
    const { serverId, type } = req.body as { serverId: string; type: 'emojis' | 'stickers' };

    if (!serverId || (type !== 'emojis' && type !== 'stickers')) {
        return res.status(400).json({ error: 'dados invalidos' });
    }

    const client = createDiscordClient();

    try {
        await client.login(req.token!);
        const guild = await client.guilds.fetch(serverId);
        const zipBuffer = await buildZip(type, guild);

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${guild.name}-${type}.zip"`);
        res.send(zipBuffer);
    } catch (error: any) {
        console.error('erro em /api/download-zip:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error?.message || String(error) });
        }
    } finally {
        client.destroy();
    }
});

app.use((_req: Request, res: Response) => {
    res.redirect('/pages/erro.html');
});

app.listen(PORT, () => {
    console.log('servidor rodando em http://localhost:' + PORT);
});