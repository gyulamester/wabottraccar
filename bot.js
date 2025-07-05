
require('dotenv').config();

const { Client, LocalAuth, Location } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrcodeBase64 = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const axios = require('axios');


const wwebVersion = process.env.WWEB_VERSION || '2.3000.1022505785-alpha';
const port = process.env.PORT || 9000;
const AUTH_USERNAME = 'admin';
const AUTH_PASSWORD = 'admin';
const VALID_TOKENS = ['token'];


let qrCodeImage = '';
let isReady = false;
let userStates = {};
const credentialsPath = './traccar_credentials.json';


const app = express();
app.use(express.json());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));



const traccarApi = axios.create({
    baseURL: process.env.TRACCAR_URL
});
-
async function loginToTraccar(username, password) {
    try {
        const params = new URLSearchParams();
        params.append('email', username);
        params.append('password', password);
        const response = await traccarApi.post('/api/session', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const cookie = response.headers['set-cookie'];
        if (cookie && cookie.length > 0) {
            return { userData: response.data, cookie: cookie[0].split(';')[0] };
        }
        return null;
    } catch (error) {
        console.error('Erro em loginToTraccar:', error.response ? `${error.response.status}`: error.message);
        return null;
    }
}

async function getTraccarDevices(username, password, sessionCookie) {
    try {
        const credentials = Buffer.from(`${username}:${password}`).toString('base64');
        const response = await traccarApi.get('/api/devices', {
            headers: { 'Authorization': `Basic ${credentials}`, 'Cookie': sessionCookie }
        });
        return response.data;
    } catch (error) {
        console.error('Erro em getTraccarDevices:', error.response ? `${error.response.status}`: error.message);
        return null;
    }
}

async function getTraccarPositionById(username, password, sessionCookie, positionId) {
    try {
        const credentials = Buffer.from(`${username}:${password}`).toString('base64');
        const response = await traccarApi.get('/api/positions', {
            headers: { 'Authorization': `Basic ${credentials}`, 'Cookie': sessionCookie },
            params: { id: positionId }
        });
        if (response.data && response.data.length > 0) return response.data[0];
        return null;
    } catch (error) {
        console.error('Erro em getTraccarPositionById:', error.response ? `${error.response.status}`: error.message);
        return null;
    }
}

async function getTraccarRoute(credentials, deviceId, from, to) {
    try {
        const basicAuth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
        const response = await traccarApi.get('/api/positions', {
            headers: { 'Authorization': `Basic ${basicAuth}` },
            params: { deviceId: deviceId, from: from.toISOString(), to: to.toISOString() }
        });
        return response.data;
    } catch (error) {
        console.error('Erro ao buscar a rota no Traccar:', error.response ? `${error.response.status}`: error.message);
        return null;
    }
}

async function sendTraccarCommand(credentials, deviceId, commandType) {
    try {
        const basicAuth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
        const response = await traccarApi.post('/api/commands/send', { deviceId: deviceId, type: commandType }, {
            headers: { 'Authorization': `Basic ${basicAuth}`, 'Cookie': credentials.cookie, 'Content-Type': 'application/json' }
        });
        if (response.status === 200 || response.status === 202) return true;
        return false;
    } catch (error) {
        console.error(`Erro ao enviar comando '${commandType}':`, error.response ? `${error.response.status}`: error.message);
        return false;
    }
}

async function requestPasswordReset(email) {
    try {
        const params = new URLSearchParams();
        params.append('email', email);
        await traccarApi.post('/api/password/reset', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        return true;
    } catch (error) {
        console.error('Erro ao solicitar reset de senha:', error.response ? `${error.response.status}`: error.message);
        return false;
    }
}

// --- Funções de Ajuda Gerais ---
function formatStatus(status) {
    if (status === 'online') return '🟢 Online';
    if (status === 'offline') return '⚫ Offline';
    return '⚪ Desconhecido';
}

function formatDateTime(isoString) {
    if (!isoString) return 'Data indisponível';
    const date = new Date(isoString);
    return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function readCredentials() {
    try {
        if (fs.existsSync(credentialsPath)) {
            const data = await fs.promises.readFile(credentialsPath, 'utf8');
            if (!data.trim()) return {};
            return JSON.parse(data);
        }
        return {};
    } catch (error) {
        console.error('Erro ao ler arquivo de credenciais:', error);
        return {};
    }
}

async function saveCredentials(data) {
    try {
        await fs.promises.writeFile(credentialsPath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Erro ao salvar credenciais:', error);
    }
}

function adjustPhoneNumber(phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 12 || cleanPhone.length > 13) throw new Error('Número de telefone inválido.');
    const countryCode = cleanPhone.slice(0, 2);
    const ddd = cleanPhone.slice(2, 4);
    let mainNumber = cleanPhone.slice(4);
    if (parseInt(ddd) <= 30 && mainNumber.length === 8) mainNumber = '9' + mainNumber;
    else if (parseInt(ddd) >= 31 && mainNumber.length === 9 && mainNumber.startsWith('9')) mainNumber = mainNumber.slice(1);
    return `${countryCode}${ddd}${mainNumber}`;
}



function createWhatsAppClient() {
    const newClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
        webVersionCache: {
            type: 'remote',
            remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${wwebVersion}.html`,
        },
    });

    newClient.on('qr', (qr) => {
        qrcode.generate(qr, { small: true });
        qrcodeBase64.toDataURL(qr, (err, url) => {
            if (err) throw err;
            qrCodeImage = url;
            isReady = false;
        });
    });

    newClient.on('ready', () => {
        console.log('WhatsApp está pronto!');
        isReady = true;
        qrCodeImage = '';
    });

    newClient.on('disconnected', (reason) => {
        console.log('Desconectado do WhatsApp:', reason);
        isReady = false;
    });

    // --- Listener de Mensagens para Interação com Usuário ---
    newClient.on('message', async (msg) => {
        const chat = await msg.getChat();
        if (chat.isGroup) return;
        const userNumber = msg.from;
        const messageBody = msg.body.trim();
    
        if (messageBody.toLowerCase() === '#sair') {
            delete userStates[userNumber];
            msg.reply('Sessão encerrada. 👋\n\nDigite `#iniciar` para começar novamente.');
            return;
        }
        if (messageBody.toLowerCase() === 'resetar senha') {
            userStates[userNumber].state = 'awaiting_reset_email';
            msg.reply('Entendido. Por favor, informe o seu *email de cadastro* no Traccar para enviarmos o link de redefinição.');
            return;
        }
        if (!userStates[userNumber]) userStates[userNumber] = {};
    
        const handleLoginAndDeviceSelection = async (username, password) => {
            msg.reply('Autenticando e buscando seus veículos... ⏳');
            const session = await loginToTraccar(username, password);
            if (!session) {
                msg.reply('❌ Falha na autenticação. Seu usuário ou senha podem estar incorretos.\n\nPara redefinir sua senha, digite: *RESETAR SENHA*');
                delete userStates[userNumber];
                return;
            }
            const { userData, cookie } = session;
            userStates[userNumber].credentials = { username, password, cookie };
            msg.reply(`Olá, *${userData.name}*! Conectado com sucesso. ✅`);
            const devices = await getTraccarDevices(username, password, cookie);
            if (!devices || devices.length === 0) {
                msg.reply('Nenhum veículo encontrado em sua conta.');
                delete userStates[userNumber];
                return;
            }
            await msg.reply(`Encontramos *${devices.length}* veículos. Por favor, *digite o ID* daquele que deseja gerenciar:`);
            const chunkSize = 8;
            let messageChunk = "";
            for (let i = 0; i < devices.length; i++) {
                const device = devices[i];
                messageChunk += `\n*Veículo:* ${device.name}\n*ID:* ${device.id} | *Status:* ${formatStatus(device.status)}\n--------------------`;
                if ((i + 1) % chunkSize === 0 || i === devices.length - 1) {
                    await newClient.sendMessage(userNumber, messageChunk.trim());
                    messageChunk = "";
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
            userStates[userNumber].state = 'awaiting_device_selection';
            userStates[userNumber].devices = devices;
        };
    
        const currentState = userStates[userNumber].state;
    
        if (messageBody.toLowerCase() === '#iniciar') {
            const credentials = await readCredentials();
            if (credentials[userNumber]) {
                await handleLoginAndDeviceSelection(credentials[userNumber].username, credentials[userNumber].password);
            } else {
                msg.reply('Olá! Detectei que é seu primeiro acesso. Por favor, digite seu *usuário* do Traccar.');
                userStates[userNumber].state = 'awaiting_username';
            }
        } else if (currentState === 'awaiting_username') {
            userStates[userNumber].temp_username = messageBody;
            msg.reply('Usuário recebido. Agora, por favor, digite sua *senha* do Traccar.');
            userStates[userNumber].state = 'awaiting_password';
        } else if (currentState === 'awaiting_password') {
            const username = userStates[userNumber].temp_username;
            const password = messageBody;
            const credentials = await readCredentials();
            credentials[userNumber] = { username, password };
            await saveCredentials(credentials);
            msg.reply('✅ Credenciais salvas com sucesso!');
            await handleLoginAndDeviceSelection(username, password);
        } else if (currentState === 'awaiting_reset_email') {
            const email = messageBody;
            const success = await requestPasswordReset(email);
            if (success) {
                msg.reply('✅ Solicitação enviada! Se o email estiver correto, você receberá um link para redefinir sua senha.');
            } else {
                msg.reply('❌ Ocorreu um erro ao processar sua solicitação.');
            }
            delete userStates[userNumber];
        } else if (currentState === 'awaiting_device_selection') {
            const selectedId = parseInt(messageBody, 10);
            const availableDevices = userStates[userNumber].devices;
            const selectedDevice = availableDevices.find(d => d.id === selectedId);
            if (selectedDevice) {
                userStates[userNumber].selectedDevice = selectedDevice;
                delete userStates[userNumber].devices;
                userStates[userNumber].state = 'awaiting_menu_choice';
                const menuText = `Veículo *${selectedDevice.name}* selecionado.\n\n*Menu Principal*\n\nDigite o comando desejado:\n\n*LOCALIZAÇÃO*\n*BLOQUEIO*\n*DESBLOQUEIO*\n*REVER*\n*TROCAR*`;
                msg.reply(menuText);
            } else {
                msg.reply('ID inválido. Por favor, digite um dos IDs da lista acima.');
            }
        } else if (currentState === 'awaiting_menu_choice') {
            const command = messageBody.toUpperCase();
            const { credentials, selectedDevice } = userStates[userNumber];
    
            if (command === 'LOCALIZAÇÃO') {
                if (!selectedDevice || !selectedDevice.positionId) {
                    msg.reply('❌ Não foi possível encontrar a última posição para este veículo.');
                    return;
                }
                msg.reply('Buscando localização, por favor aguarde... 🛰️');
                const position = await getTraccarPositionById(credentials.username, credentials.password, credentials.cookie, selectedDevice.positionId);
                if (position) {
                    const speedInKmh = position.speed * 1.852;
                    const movimento = position.attributes.motion ? '✅ Em movimento' : '🛑 Parado';
                    const ignicao = position.attributes.ignition ? '🟢 Ligada' : '⚫ Desligada';
                    const bloqueio = position.attributes.blocked ? '🔒 Sim' : '🔓 Não';
                    const locationDescription = `Velocidade: ${speedInKmh.toFixed(0)} km/h\nÚltima atualização: ${formatDateTime(position.fixTime)}`;
                    const locationMessage = new Location(position.latitude, position.longitude, { name: `📍 ${selectedDevice.name}`, address: position.address, description: locationDescription });
                    await newClient.sendMessage(userNumber, locationMessage);
                    const infoText = `*Informações Adicionais:*\n\n*Endereço:* ${position.address || 'Não disponível'}\n*Movimento:* ${movimento}\n*Ignição:* ${ignicao}\n*Bloqueado:* ${bloqueio}`;
                    await newClient.sendMessage(userNumber, infoText);
                } else {
                    msg.reply('❌ Não foi possível obter os detalhes da localização. Tente novamente.');
                }
            
            } else if (command === 'BLOQUEIO') {
                msg.reply(`Enviando comando de *bloqueio* para o veículo *${selectedDevice.name}*... 🔒`);
                const success = await sendTraccarCommand(credentials, selectedDevice.id, 'engineStop');
                if (success) msg.reply(`✅ Comando de bloqueio enviado com sucesso para *${selectedDevice.name}*.`);
                else msg.reply(`❌ Falha ao enviar o comando de bloqueio.`);
    
            } else if (command === 'DESBLOQUEIO') {
                msg.reply(`Enviando comando de *desbloqueio* para o veículo *${selectedDevice.name}*... 🔓`);
                const success = await sendTraccarCommand(credentials, selectedDevice.id, 'engineResume');
                if (success) msg.reply(`✅ Comando de desbloqueio enviado com sucesso para *${selectedDevice.name}*.`);
                else msg.reply(`❌ Falha ao enviar o comando de desbloqueio.`);
            
            } else if (command === 'REVER') {
                msg.reply('Gerando rota navegável das últimas posições, por favor aguarde... 🗺️');
                const to = new Date();
                const from = new Date(to.getTime() - 15 * 60 * 1000);
                const allPositions = await getTraccarRoute(credentials, selectedDevice.id, from, to);
    
                if (allPositions && allPositions.length >= 2) {
                    const recentPositions = allPositions.slice(-8);
                    const origin = recentPositions[0];
                    const destination = recentPositions[recentPositions.length - 1];
                    const originCoord = `${origin.latitude.toFixed(6)},${origin.longitude.toFixed(6)}`;
                    const destinationCoord = `${destination.latitude.toFixed(6)},${destination.longitude.toFixed(6)}`;
                    const waypoints = recentPositions.slice(1, -1).map(p => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`).join('|');
                    let googleMapsUrl = `https://www.google.com/maps/dir/-5.6655616,-36.6878288/-5.6636033,-36.7011444/-5.6626333,-36.7144577/-5.6616283,-36.7280533/-5.66066,-36.74116222&origin=${originCoord}&destination=${destinationCoord}`;
                    if (waypoints) googleMapsUrl += `&waypoints=${waypoints}`;
                    googleMapsUrl += `&dir_action=navigate`;
                    const replyText = `Rota navegável das últimas posições para *${selectedDevice.name}*.\n\nClique no link para iniciar a navegação:\n${googleMapsUrl}`;
                    msg.reply(replyText);
                } else {
                    msg.reply(`❌ Não foram encontradas posições suficientes (mínimo 2) nos últimos 15 minutos para gerar uma rota.`);
                }

            } else if (command === 'TROCAR') {
                msg.reply('Buscando sua lista de veículos novamente... 🚗');
                const { username, password, cookie } = credentials;
                const devices = await getTraccarDevices(username, password, cookie);
                if (!devices || devices.length === 0) {
                    msg.reply('❌ Não foi possível buscar sua lista de veículos. Tente novamente mais tarde.');
                    return;
                }
                delete userStates[userNumber].selectedDevice;
                await msg.reply(`Você pode selecionar um novo veículo. *Digite o ID* daquele que deseja gerenciar:`);
                const chunkSize = 8;
                let messageChunk = "";
                for (let i = 0; i < devices.length; i++) {
                    const device = devices[i];
                    messageChunk += `\n*Veículo:* ${device.name}\n*ID:* ${device.id} | *Status:* ${formatStatus(device.status)}\n--------------------`;
                    if ((i + 1) % chunkSize === 0 || i === devices.length - 1) {
                        await newClient.sendMessage(userNumber, messageChunk.trim());
                        messageChunk = "";
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }
                userStates[userNumber].state = 'awaiting_device_selection';
                userStates[userNumber].devices = devices;
                
            } else {
                msg.reply(`Comando "*${command}*" não reconhecido. Por favor, escolha uma das opções do menu.`);
            }
        }
    });

    newClient.initialize();
    return newClient;
}

let client = createWhatsAppClient();



const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic');
        return res.status(401).send('Autenticação necessária.');
    }
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');
    if (username === AUTH_USERNAME && password === AUTH_PASSWORD) return next();
    else return res.status(403).send('Acesso negado.');
};

const validateToken = (req, res, next) => {
    const token = req.query.token || req.body.token;
    if (!VALID_TOKENS.includes(token)) return res.status(403).json({ error: 'Token inválido.' });
    next();
};

app.get('/restart', async (req, res) => {
    // Código da rota /restart original (com HTML grande)
    // Omitido por brevidade, mas deve ser mantido como estava no seu código original
    res.send('Funcionalidade de Restart aqui.');
});

app.get('/qr', authenticate, (req, res) => {
    // Código da rota /qr original (com HTML grande)
    // Omitido por brevidade, mas deve ser mantido como estava no seu código original
    res.send('Funcionalidade de QR Code aqui.');
});

app.get('/status', authenticate, (req, res) => {
    res.json({ status: isReady ? 'ready' : 'not_ready' });
});

app.get('/send', validateToken, (req, res) => {
    // Código da rota /send (GET) original
    // Omitido por brevidade, mas deve ser mantido como estava
    res.send('Funcionalidade de Send (GET) aqui.');
});

app.post('/send', validateToken, (req, res) => {
    // Código da rota /send (POST) original
    // Omitido por brevidade, mas deve ser mantido como estava
    res.send('Funcionalidade de Send (POST) aqui.');
});



app.listen(port, '0.0.0.0', () => {
    console.log(`API e servidor web escutando na porta ${port}`);
});