import { App, Notice, Plugin, Modal, PluginSettingTab, Setting, FileSystemAdapter } from 'obsidian';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

interface MyPluginSettings {
    googleApiKey: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
    googleApiKey: ''
}

function arrayBufferToBase64(aBuffer: ArrayBuffer): string {
    const uint8Array = new Uint8Array(aBuffer); // Create a Uint8Array view of the ArrayBuffer
    let binaryString = "";
    for (let i = 0; i < uint8Array.length; i++) {
        binaryString += String.fromCharCode(uint8Array[i]); // Convert each byte to a character
    }
    return btoa(binaryString); // Encode the binary string to Base64
}

export default class MyPlugin extends Plugin {
    settings: MyPluginSettings;
    private isRecording: boolean = false;
    private mediaRecorder: MediaRecorder | null = null;
    private recordedChunks: Blob[] = [];
    private genAI: any;
    private fileManager: any;

    async onload() {
        await this.loadSettings();

        // Add a ribbon icon to open the recording modal
        const ribbonIconEl = this.addRibbonIcon('microphone', 'Open Recording Modal', () => {
            new RecordingModal(this.app, this).open();
        });
        ribbonIconEl.addClass('my-plugin-ribbon-icon');

        // Add a command to open the recording modal
        this.addCommand({
            id: 'open-recording-modal',
            name: 'Open Recording Modal',
            callback: () => {
                new RecordingModal(this.app, this).open();
            }
        });

        // Add a settings tab
        this.addSettingTab(new GoogleApiKeySettingTab(this.app, this));

        // Initialize Gemini model
        if (this.settings.googleApiKey) {
            this.initializeGemini();
        }
    }

    onunload() {
        // Clean up resources if needed
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    public initializeGemini() {
        this.genAI = new GoogleGenerativeAI(this.settings.googleApiKey);
        this.fileManager = new GoogleAIFileManager(this.settings.googleApiKey);
    }

    public async startRecording() {
        if (this.isRecording) return;

        this.isRecording = true;
        this.recordedChunks = []; // Reset recorded chunks

        // Play a beep sound before recording
        this.playBeep(440, 200);

        // Get audio stream
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.mediaRecorder = new MediaRecorder(stream);
            this.mediaRecorder.ondataavailable = (event) => {
                this.recordedChunks.push(event.data);
            };
            this.mediaRecorder.onstop = this.saveRecording.bind(this);
            this.mediaRecorder.start();
        } catch (error) {
            new Notice('Failed to start recording. Please ensure microphone access is granted.');
            console.error('Error starting recording:', error);
            this.isRecording = false;
        }
    }

    public async stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return;

        this.isRecording = false;
        this.mediaRecorder.stop();

        // Stop all tracks in the stream
        if (this.mediaRecorder.stream) {
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }

        // Play a beep sound after recording
        this.playBeep(880, 200);
    }

    private async saveRecording() {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const dirPath = '.records/pre_proc'; // Directory path
        const fileName = `recording_${Date.now()}.webm`; // File name
        const fullPath = `${dirPath}/${fileName}`; // Full path to the file
        let absolutePath = "";
        let adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            absolutePath = `${adapter.getBasePath()}/${fullPath}`;
        }

        try {
            // Check if the directory exists, and create it if it doesn't
            if (!await this.app.vault.adapter.exists(dirPath)) {
                await this.app.vault.createFolder(dirPath);
                console.log(`Created directory: ${dirPath}`);
            }

            // Save the recording file
            new Notice('Recording saved successfully!');
            (`Saving file to: ${fullPath}`);
            await this.app.vault.createBinary(fullPath, arrayBuffer);
            new Notice('File saved successfully.');

            // Wait for a short period to ensure the file is fully saved
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay

            // Verify that the file exists before proceeding
            const fileExists = await this.app.vault.adapter.exists(fullPath);
            if (!fileExists) {
                throw new Error('File was not saved correctly.');
            }
            new Notice(`File ${fullPath} exists, proceeding with Gemini processing.`);
            // new Notice(`fullpath ${fullPath}`)
            // new Notice(`absolutepath ()()${absolutePath}`)
            // Process the recording with Gemini
            await this.processRecordingWithGemini(arrayBuffer);
        } catch (error) {
            new Notice('Failed to save recording. Please try again.');
            console.error('Error saving recording:', error);
        }
    }

    private async processRecordingWithGemini(aBuffer: ArrayBuffer) {
        if (!this.genAI || !this.fileManager) {
            new Notice('Gemini is not initialized. Please check your API key.');
            return;
        }
        new Notice("entered Gemini processing")
        const audioData = arrayBufferToBase64(aBuffer);
        new Notice("created Buffer")


        try {
            // const file = await this.uploadToGemini(filePath, 'audio/webm');

            // Define the tools (functions) for Gemini
            const tools = [
                {
                    functionDeclarations: [
                        {
                            name: "createFile",
                            description: "creates a file in path with content",
                            parameters: {
                                type: "object",
                                properties: {
                                    path: { type: "string" },
                                    content: { type: "string" },
                                },
                                required: ["path", "content"],
                            },
                        },
                        {
                            name: "tellUser",
                            description: "sends the user a message",
                            parameters: {
                                type: "object",
                                properties: {
                                    message: { type: "string" },
                                },
                                required: ["message"],
                            },
                        },
                    ],
                },
            ];

            // Create a dictionary to map function names to their implementations
            const functions: { [name: string]: Function } = {
                createFile: this.createFile.bind(this),
                tellUser: this.tellUser.bind(this),
            };

            // Initialize the Gemini model with tools and system instruction
            const model = this.genAI.getGenerativeModel({
                model: "gemini-2.0-flash-exp",
                systemInstruction: `Eres un asistente inteligente con acceso a herramientas específicas para gestionar y manipular archivos, así como para comunicarte con el usuario. Entre tus capacidades, puedes crear archivos utilizando la función createFile, la cual te permite generar un archivo en una ruta específica con un contenido determinado. Además, cuentas con la función tellUser para enviar mensajes al usuario de manera clara y directa.

Recuerda que el uso de estas herramientas es opcional y debe basarse en la relevancia y las necesidades específicas de la interacción con el usuario. Toda comunicación o información que debas proporcionar al usuario final debe realizarse exclusivamente a través de la función tellUser. Los mensajes enviados a través de tellUser deben ser cortos, claros y concisos, evitando información innecesaria o extensa. Esta función es tu canal oficial para interactuar con el usuario.

Cuando crees archivos, asegúrate de usar nombres que reflejen claramente el contenido del archivo. Por ejemplo, si el archivo contiene información sobre un informe financiero, un nombre adecuado podría ser informe_financiero_2023.txt. Esto ayudará al usuario a identificar fácilmente el propósito del archivo.

Además, cuando generes contenido para archivos, utiliza formato Markdown para mejorar la legibilidad y estructura del texto. Por ejemplo, usa encabezados (#, ##), listas (-, *), negritas (**texto**) y otros elementos de Markdown para organizar la información de manera clara y profesional.

Como gestor de archivos, evalúa cuidadosamente si es necesario crear nuevos archivos o realizar cambios en los existentes. Solo procede con estas acciones si son esenciales para cumplir con la solicitud del usuario o si el usuario lo solicita explícitamente. Prioriza la claridad y la eficiencia en tu gestión, asegurándote de que todas las acciones estén justificadas y sean útiles para el usuario.

En resumen:

    Usa la función createFile solo cuando sea necesario o solicitado por el usuario.

    Comunícate con el usuario únicamente a través de la función tellUser, manteniendo los mensajes cortos y claros.

    Asigna nombres a los archivos que reflejen su contenido de manera descriptiva.

    Utiliza formato Markdown para estructurar y mejorar la legibilidad del contenido de los archivos.

    Evalúa la necesidad de crear o modificar archivos antes de proceder.

Tu objetivo es ser útil, claro y eficiente en todo momento, utilizando las herramientas disponibles de manera adecuada y solo cuando sea necesario.`,
                tools,
                toolConfig: { functionCallingConfig: { mode: "AUTO" } }, // Changed to AUTO
            });

            const generationConfig = {
                temperature: 0.3,
                topP: 0.95,
                topK: 40,
                maxOutputTokens: 8192,
                responseMimeType: "text/plain",
            };

            // Start the chat session
            const chatSession = model.startChat({
                generationConfig,
                history: [
                    {
                        role: "user",
                        parts: [
                            {
                                inlineData: {
                                    data: audioData,
                                    mimeType: "audio/mp3",
                                },
                            },
							{ text: `Escucha las instrucciones en el audio y actua acordemente
recuerda que los archivos deben ser .md (markdown) y tener tal formato
Puedes decir al usuario toda la informacion que consideres necesaria, si es demasiado largo, puedes picarla en trozos mas pequenos.
Puedes incluir vinculos a otros archivos usando [[filename]] en el contenido de un archivo (filename no debe incluir la extension)` },
                        ],
                    },
                ],
            });

            // Send a message to the chat session
			new Notice("start sending");
            const result = await chatSession.sendMessage("INSERT_INPUT_HERE");
			new Notice("end sending");
			console.log("RESULTADO");
            console.log(result);
            // Handle function calls in the response
            for (const candidate of result.response.candidates) {
                for (const part of candidate.content.parts) {
                    if (part.functionCall) {
                        const { name, args } = part.functionCall;
                        const functionRef = functions[name];
                        if (!functionRef) {
                            throw new Error(`Unknown function "${name}"`);
                        }

                        // Execute the function
                        const functionResponse = functionRef(args);

                    }
                }
            }

            
            new Notice('Recording processed successfully!');
        } catch (error) {
            new Notice('Failed to process recording with Gemini.');
            console.error('Error processing recording:', error);
        }
    }

    private async uploadToGemini(path: string, mimeType: string) {
        const uploadResult = await this.fileManager.uploadFile(path, {
            mimeType,
            displayName: path,
        });
        const file = uploadResult.file;
        console.log(`Uploaded file ${file.displayName} as: ${file.name}`);
        return file;
    }

    private playBeep(frequency: number, duration: number) {
        const audioContext = new AudioContext();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.start();
        gainNode.gain.setValueAtTime(1, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration / 1000);
        oscillator.stop(audioContext.currentTime + duration / 1000);
    }

    // Function implementations
    private async createFile(args: { path: string; content: string }): Promise<string> {
		try {
			// Replace escaped newlines with actual newlines
			const contentWithNewlines = args.content.replace(/\\n/g, '\n');
	
			// Write the file with the corrected content
			await this.app.vault.adapter.write(args.path, contentWithNewlines);
			new Notice(`File created successfully at ${args.path}`);
			return `File created successfully at ${args.path}`;
		} catch (error) {
			throw new Error(`Failed to create file: ${error}`);
		}
	}

    private tellUser(args: { message: string }): string {
        new Notice(args.message);
        return `User notified with message: ${args.message}`;
    }
    
}


class RecordingModal extends Modal {
    plugin: MyPlugin;

    constructor(app: App, plugin: MyPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;

        // Create a container for the button
        const buttonContainer = contentEl.createEl('div', {
            cls: 'record-button-container',
        });

        // Create a red circle button
        const recordButton = buttonContainer.createEl('button', {
            cls: 'record-button',
            text: '●',
        });

        // Add event listeners for mouse and touch events
        recordButton.addEventListener('mousedown', () => this.plugin.startRecording());
        recordButton.addEventListener('mouseup', () => this.plugin.stopRecording());
        recordButton.addEventListener('touchstart', () => this.plugin.startRecording());
        recordButton.addEventListener('touchend', () => this.plugin.stopRecording());
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class GoogleApiKeySettingTab extends PluginSettingTab {
    plugin: MyPlugin;

    constructor(app: App, plugin: MyPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('Google API Key')
            .setDesc('Enter your Google API key for Gemini')
            .addText(text => text
                .setPlaceholder('Enter your API key')
                .setValue(this.plugin.settings.googleApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.googleApiKey = value;
                    await this.plugin.saveSettings();
                    this.plugin.initializeGemini(); // Reinitialize Gemini with the new API key
                })
                .inputEl.type = 'password' // Hide the API key as a password
            );
    }
}