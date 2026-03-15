import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { createWritableMemo } from "@solid-primitives/memo";
import { createElementSize } from "@solid-primitives/resize-observer";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { batch, createEffect, createSignal, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import toast from "solid-toast";
import { Toggle } from "~/components/Toggle";
import type { CaptionSegment, CaptionSettings } from "~/utils/tauri";
import { commands, events } from "~/utils/tauri";
import { FPS, OUTPUT_SIZE, useEditorContext } from "./context";
import { TextInput } from "./TextInput";
import {
	Field,
	Input,
	MenuItem,
	MenuItemList,
	PopperContent,
	Slider,
	Subfield,
	topLeftAnimateClasses,
} from "./ui";

// Model information
interface ModelOption {
	name: string;
	label: string;
}

interface LanguageOption {
	code: string;
	label: string;
}

interface FontOption {
	value: string;
	label: string;
}

const MODEL_OPTIONS: ModelOption[] = [
	{ name: "tiny", label: "微型 (75MB) - 最快，精度较低" },
	{ name: "base", label: "基础 (142MB) - 快速，精度适中" },
	{ name: "small", label: "小型 (466MB) - 速度与精度平衡" },
	{ name: "medium", label: "中型 (1.5GB) - 较慢，精度较高" },
	{ name: "large-v3", label: "大型 (3GB) - 最慢，精度最高" },
];

const LANGUAGE_OPTIONS: LanguageOption[] = [
	{ code: "auto", label: "自动检测" },
	{ code: "en", label: "英语" },
	{ code: "es", label: "西班牙语" },
	{ code: "fr", label: "法语" },
	{ code: "de", label: "德语" },
	{ code: "it", label: "意大利语" },
	{ code: "pt", label: "葡萄牙语" },
	{ code: "nl", label: "荷兰语" },
	{ code: "pl", label: "波兰语" },
	{ code: "ru", label: "俄语" },
	{ code: "tr", label: "土耳其语" },
	{ code: "ja", label: "日语" },
	{ code: "ko", label: "韩语" },
	{ code: "zh", label: "中文" },
];

const DEFAULT_MODEL = "small";
const MODEL_FOLDER = "transcription_models";

// Custom flat button component since we can't import it
function FlatButton(props: {
	class?: string;
	onClick?: () => void;
	disabled?: boolean;
	children: any;
}) {
	return (
		<button
			class={`px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-gray-1 dark:text-gray-1 rounded-md transition-colors ${
				props.class || ""
			}`}
			onClick={props.onClick}
			disabled={props.disabled}
		>
			{props.children}
		</button>
	);
}

const fontOptions = [
	{ value: "System Sans-Serif", label: "系统无衬线字体" },
	{ value: "System Serif", label: "系统衬线字体" },
	{ value: "System Monospace", label: "系统等宽字体" },
];

// Add type definitions at the top
interface CaptionsResponse {
	segments: CaptionSegment[];
}

// Color conversion types
type RGB = [number, number, number];

// Helper functions for color conversion
function hexToRgb(hex: string): RGB {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	return result
		? [
				parseInt(result[1], 16),
				parseInt(result[2], 16),
				parseInt(result[3], 16),
			]
		: [0, 0, 0];
}

function rgbToHex(rgb: RGB): string {
	return `#${rgb.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

// Add RgbInput component at the top level
function RgbInput(props: { value: string; onChange: (value: string) => void }) {
	const [text, setText] = createWritableMemo(() => props.value);
	let prevColor = props.value;
	let colorInput!: HTMLInputElement;

	return (
		<div class="flex flex-row items-center gap-[0.5rem] relative">
			<button
				type="button"
				class="size-[1.5rem] rounded-[0.25rem]"
				style={{
					"background-color": text(),
				}}
				onClick={() => colorInput.click()}
			/>
			<input
				ref={colorInput}
				type="color"
				class="absolute left-0 bottom-0 w-[1.5rem] opacity-0"
				value={text()}
				onChange={(e) => {
					setText(e.target.value);
					props.onChange(e.target.value);
				}}
			/>
			<TextInput
				class="w-[5rem] p-[0.375rem] border text-gray-400 rounded-[0.5rem] bg-gray-50"
				value={text()}
				onFocus={() => {
					prevColor = props.value;
				}}
				onInput={(e) => {
					setText(e.currentTarget.value);
					props.onChange(e.currentTarget.value);
				}}
				onBlur={(e) => {
					if (!/^#[0-9A-F]{6}$/i.test(e.target.value)) {
						setText(prevColor);
						props.onChange(prevColor);
					}
				}}
			/>
		</div>
	);
}

// Add scroll position preservation for the container
export function CaptionsTab() {
	const { project, setProject, editorInstance, editorState } =
		useEditorContext();

	// Scroll management
	let scrollContainerRef: HTMLDivElement | undefined;
	const [scrollState, setScrollState] = createStore({
		lastScrollTop: 0,
		isScrolling: false,
	});

	// Track container size changes
	const size = createElementSize(() => scrollContainerRef);

	// Create a local store for caption settings to avoid direct project mutations
	const [captionSettings, setCaptionSettings] = createStore(
		project?.captions?.settings || {
			enabled: true,
			font: "System Sans-Serif",
			size: 24,
			color: "#FFFFFF",
			backgroundColor: "#000000",
			backgroundOpacity: 80,
			position: "bottom",
			bold: true,
			italic: false,
			outline: true,
			outlineColor: "#000000",
			exportWithSubtitles: false,
		},
	);

	// Sync caption settings with project and update player
	createEffect(() => {
		if (!project?.captions) return;

		const settings = captionSettings;

		// Only update if there are actual changes
		if (
			JSON.stringify(settings) !== JSON.stringify(project.captions.settings)
		) {
			batch(() => {
				// Update project settings
				setProject("captions", "settings", settings);

				// Force player refresh
				events.renderFrameEvent.emit({
					frame_number: Math.floor(editorState.playbackTime * FPS),
					fps: FPS,
					resolution_base: OUTPUT_SIZE,
				});
			});
		}
	});

	// Sync project settings to local store
	createEffect(() => {
		if (project?.captions?.settings) {
			setCaptionSettings(project.captions.settings);
		}
	});

	// Helper function to update caption settings
	const updateCaptionSetting = (key: keyof CaptionSettings, value: any) => {
		if (!project?.captions) return;

		// Store scroll position before update
		if (scrollContainerRef) {
			setScrollState("lastScrollTop", scrollContainerRef.scrollTop);
		}

		// Update local store
		setCaptionSettings({
			...captionSettings,
			[key]: value,
		});

		// For font changes, force an immediate player update
		if (key === "font") {
			events.renderFrameEvent.emit({
				frame_number: Math.floor(editorState.playbackTime * FPS),
				fps: FPS,
				resolution_base: OUTPUT_SIZE,
			});
		}
	};

	// Restore scroll position after any content changes
	createEffect(() => {
		// Track any size changes
		const _ = size.height;

		// Restore scroll position if we have one
		if (scrollContainerRef && scrollState.lastScrollTop > 0) {
			requestAnimationFrame(() => {
				scrollContainerRef!.scrollTop = scrollState.lastScrollTop;
			});
		}
	});

	// Add model selection state
	const [selectedModel, setSelectedModel] = createSignal(DEFAULT_MODEL);
	const [selectedLanguage, setSelectedLanguage] = createSignal("auto");
	const [downloadedModels, setDownloadedModels] = createSignal<string[]>([]);

	// States for captions
	const [modelExists, setModelExists] = createSignal(false);
	const [isDownloading, setIsDownloading] = createSignal(false);
	const [downloadProgress, setDownloadProgress] = createSignal(0);
	const [downloadingModel, setDownloadingModel] = createSignal<string | null>(
		null,
	);
	const [isGenerating, setIsGenerating] = createSignal(false);
	const [hasAudio, setHasAudio] = createSignal(false);
	const [modelPath, setModelPath] = createSignal("");
	const [currentCaption, setCurrentCaption] = createSignal<string | null>(null);

	// Ensure captions object is initialized in project config
	createEffect(() => {
		if (!project || !editorInstance) return;

		if (!project.captions) {
			// Initialize captions with default settings
			setProject("captions", {
				segments: [],
				settings: {
					enabled: true,
					font: "System Sans-Serif",
					size: 24,
					color: "#FFFFFF",
					backgroundColor: "#000000",
					backgroundOpacity: 80,
					position: "bottom",
					bold: true,
					italic: false,
					outline: true,
					outlineColor: "#000000",
					exportWithSubtitles: false,
				},
			});
		}
	});

	// Check downloaded models on mount
	onMount(async () => {
		try {
			// Check for downloaded models
			const appDataDirPath = await appLocalDataDir();
			const modelsPath = await join(appDataDirPath, MODEL_FOLDER);

			// Create models directory if it doesn't exist
			if (!(await exists(modelsPath))) {
				await commands.createDir(modelsPath, true);
			}

			// Check which models are already downloaded
			const models = await Promise.all(
				MODEL_OPTIONS.map(async (model) => {
					const downloaded = await checkModelExists(model.name);
					return { name: model.name, downloaded };
				}),
			);

			// Set available models
			setDownloadedModels(
				models.filter((m) => m.downloaded).map((m) => m.name),
			);

			// Check if current model exists
			if (selectedModel()) {
				setModelExists(await checkModelExists(selectedModel()));
			}

			// Check if the video has audio
			if (editorInstance && editorInstance.recordings) {
				const hasAudioTrack = editorInstance.recordings.segments.some(
					(segment) => segment.mic !== null || segment.system_audio !== null,
				);
				setHasAudio(hasAudioTrack);
			}

			// Restore download state if there was an ongoing download
			const downloadState = localStorage.getItem("modelDownloadState");
			if (downloadState) {
				const { model, progress } = JSON.parse(downloadState);
				if (model && progress < 100) {
					setDownloadingModel(model);
					setDownloadProgress(progress);
					setIsDownloading(true);
				} else {
					localStorage.removeItem("modelDownloadState");
				}
			}
		} catch (error) {
			console.error("Error checking models:", error);
		}
	});

	// Save download state when it changes
	createEffect(() => {
		if (isDownloading() && downloadingModel()) {
			localStorage.setItem(
				"modelDownloadState",
				JSON.stringify({
					model: downloadingModel(),
					progress: downloadProgress(),
				}),
			);
		} else {
			localStorage.removeItem("modelDownloadState");
		}
	});

	// Effect to update current caption based on playback time
	createEffect(() => {
		if (!project?.captions?.segments || editorState.playbackTime === undefined)
			return;

		const time = editorState.playbackTime;
		const segments = project.captions.segments;

		// Binary search for the correct segment
		const findSegment = (
			time: number,
			segments: CaptionSegment[],
		): CaptionSegment | undefined => {
			let left = 0;
			let right = segments.length - 1;

			while (left <= right) {
				const mid = Math.floor((left + right) / 2);
				const segment = segments[mid];

				if (time >= segment.start && time < segment.end) {
					return segment;
				}

				if (time < segment.start) {
					right = mid - 1;
				} else {
					left = mid + 1;
				}
			}

			return undefined;
		};

		// Find the current segment using binary search
		const currentSegment = findSegment(time, segments);

		// Only update if the caption has changed
		if (currentSegment?.text !== currentCaption()) {
			setCurrentCaption(currentSegment?.text || null);
		}
	});

	const checkModelExists = async (modelName: string) => {
		const appDataDirPath = await appLocalDataDir();
		const modelsPath = await join(appDataDirPath, MODEL_FOLDER);
		const modelPath = await join(modelsPath, `${modelName}.bin`);
		setModelPath(modelPath);
		return await commands.checkModelExists(modelPath);
	};

	const downloadModel = async () => {
		try {
			const modelToDownload = selectedModel();
			setIsDownloading(true);
			setDownloadProgress(0);
			setDownloadingModel(modelToDownload);

			// Create the directory if it doesn't exist
			const appDataDirPath = await appLocalDataDir();
			const modelsPath = await join(appDataDirPath, MODEL_FOLDER);
			const modelPath = await join(modelsPath, `${modelToDownload}.bin`);

			try {
				await commands.createDir(modelsPath, true);
			} catch (err) {
				console.error("Error creating directory:", err);
			}

			// Set up progress listener
			const unlisten = await events.downloadProgress.listen((event) => {
				setDownloadProgress(event.payload.progress);
			});

			// Download the model
			await commands.downloadWhisperModel(modelToDownload, modelPath);

			// Clean up listener
			unlisten();

			// Update downloaded models list
			setDownloadedModels((prev) => [...prev, modelToDownload]);
			setModelExists(true);
			toast.success("转录模型下载成功！");
		} catch (error) {
			console.error("Error downloading model:", error);
			toast.error("下载转录模型失败");
		} finally {
			setIsDownloading(false);
			setDownloadingModel(null);
		}
	};

	const generateCaptions = async () => {
		if (!editorInstance) {
			toast.error("未找到编辑器实例");
			return;
		}

		setIsGenerating(true);

		try {
			const videoPath = editorInstance.path;
			const lang = selectedLanguage();
			const currentModelPath = await join(
				await appLocalDataDir(),
				MODEL_FOLDER,
				`${selectedModel()}.bin`,
			);

			// Verify file existence before proceeding
			const result = await commands.transcribeAudio(
				videoPath,
				currentModelPath,
				lang,
			);

			if (result && result.segments.length > 0) {
				// Update project with the new segments
				setProject("captions", "segments", result.segments);
				updateCaptionSetting("enabled", true);
				toast.success("字幕生成成功！");
			} else {
				toast.error(
					"未生成字幕。音频可能太安静或不清晰。",
				);
			}
		} catch (error) {
			console.error("Error generating captions:", error);
			let errorMessage = "发生未知错误";

			if (error instanceof Error) {
				errorMessage = error.message;
			} else if (typeof error === "string") {
				errorMessage = error;
			}

			// Provide more user-friendly error messages
			if (errorMessage.includes("No audio stream found")) {
				errorMessage = "视频文件中未找到音频";
			} else if (errorMessage.includes("Model file not found")) {
				errorMessage = "未找到字幕模型，请先下载";
			} else if (errorMessage.includes("Failed to load Whisper model")) {
				errorMessage =
					"加载字幕模型失败，请尝试重新下载";
			}

			toast.error("生成字幕失败：" + errorMessage);
		} finally {
			setIsGenerating(false);
		}
	};

	// Segment operations that update project directly
	const deleteSegment = (id: string) => {
		if (!project?.captions?.segments) return;

		setProject(
			"captions",
			"segments",
			project.captions.segments.filter((segment) => segment.id !== id),
		);
	};

	const updateSegment = (
		id: string,
		updates: Partial<{ start: number; end: number; text: string }>,
	) => {
		if (!project?.captions?.segments) return;

		setProject(
			"captions",
			"segments",
			project.captions.segments.map((segment) =>
				segment.id === id ? { ...segment, ...updates } : segment,
			),
		);
	};

	const addSegment = (time: number) => {
		if (!project?.captions) return;

		const id = `segment-${Date.now()}`;
		setProject("captions", "segments", [
			...project.captions.segments,
			{
				id,
				start: time,
				end: time + 2,
				text: "新字幕",
			},
		]);
	};

	return (
		<div class="flex flex-col h-full">
			<div
				class="p-[0.75rem] text-[0.875rem] h-full transition-[height] duration-200"
				ref={(el) => (scrollContainerRef = el)}
				onScroll={() => {
					if (!scrollState.isScrolling && scrollContainerRef) {
						setScrollState("isScrolling", true);
						setScrollState("lastScrollTop", scrollContainerRef.scrollTop);

						// Reset scrolling flag after scroll ends
						setTimeout(() => {
							setScrollState("isScrolling", false);
						}, 150);
					}
				}}
			>
				<div class="flex flex-col gap-4">
					<Subfield name="启用字幕">
						<Toggle
							checked={captionSettings.enabled}
							onChange={(checked) => updateCaptionSetting("enabled", checked)}
						/>
					</Subfield>

					<Show when={captionSettings.enabled}>
						<div class="space-y-6 transition-all duration-200">
								{/* Model Selection and Download Section */}
								<div class="space-y-4">
									<div class="space-y-2">
										<label class="text-xs text-gray-500">当前模型</label>
										<KSelect<string>
											options={MODEL_OPTIONS.filter((m) =>
												downloadedModels().includes(m.name),
											).map((m) => m.name)}
											value={selectedModel()}
											onChange={(value: string | null) => {
												if (value) {
													batch(() => {
														setSelectedModel(value);
														setModelExists(downloadedModels().includes(value));
													});
												}
											}}
											itemComponent={(props) => (
												<MenuItem<typeof KSelect.Item>
													as={KSelect.Item}
													item={props.item}
												>
													<KSelect.ItemLabel class="flex-1">
														{
															MODEL_OPTIONS.find(
																(m) => m.name === props.item.rawValue,
															)?.label
														}
													</KSelect.ItemLabel>
												</MenuItem>
											)}
										>
											<KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
												<KSelect.Value<string> class="flex-1 text-left truncate">
													{(state) => {
														const model = MODEL_OPTIONS.find(
															(m) => m.name === state.selectedOption(),
														);
														return (
															<span>{model?.label || "选择模型"}</span>
														);
													}}
												</KSelect.Value>
												<KSelect.Icon>
													<IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180" />
												</KSelect.Icon>
											</KSelect.Trigger>
											<KSelect.Portal>
												<PopperContent<typeof KSelect.Content>
													as={KSelect.Content}
													class={topLeftAnimateClasses}
												>
													<MenuItemList<typeof KSelect.Listbox>
														class="max-h-48 overflow-y-auto"
														as={KSelect.Listbox}
													/>
												</PopperContent>
											</KSelect.Portal>
										</KSelect>
									</div>

									<div class="space-y-2">
										<label class="text-xs text-gray-500">
											下载新模型
										</label>
										<KSelect<string>
											options={MODEL_OPTIONS.map((m) => m.name)}
											value={selectedModel()}
											onChange={(value: string | null) => {
												if (value) setSelectedModel(value);
											}}
											disabled={isDownloading()}
											itemComponent={(props) => (
												<MenuItem<typeof KSelect.Item>
													as={KSelect.Item}
													item={props.item}
												>
													<KSelect.ItemLabel class="flex-1">
														{
															MODEL_OPTIONS.find(
																(m) => m.name === props.item.rawValue,
															)?.label
														}
														{downloadedModels().includes(props.item.rawValue)
															? "（已下载）"
															: ""}
													</KSelect.ItemLabel>
												</MenuItem>
											)}
										>
											<KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
												<KSelect.Value<string> class="flex-1 text-left truncate">
													{(state) => {
														const model = MODEL_OPTIONS.find(
															(m) => m.name === state.selectedOption(),
														);
														return (
															<span>{model?.label || "选择模型"}</span>
														);
													}}
												</KSelect.Value>
												<KSelect.Icon>
													<IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180" />
												</KSelect.Icon>
											</KSelect.Trigger>
											<KSelect.Portal>
												<PopperContent<typeof KSelect.Content>
													as={KSelect.Content}
													class={topLeftAnimateClasses}
												>
													<MenuItemList<typeof KSelect.Listbox>
														class="max-h-48 overflow-y-auto"
														as={KSelect.Listbox}
													/>
												</PopperContent>
											</KSelect.Portal>
										</KSelect>
									</div>

									<Show
										when={isDownloading()}
										fallback={
											<Button
												class="w-full"
												onClick={downloadModel}
												disabled={
													isDownloading() ||
													downloadedModels().includes(selectedModel())
												}
											>
												下载{" "}
												{
													MODEL_OPTIONS.find((m) => m.name === selectedModel())
														?.label
												}
											</Button>
										}
									>
										<div class="space-y-2">
											<div class="w-full bg-gray-100 rounded-full h-2">
												<div
													class="bg-blue-500 h-2 rounded-full transition-all duration-300"
													style={{ width: `${downloadProgress()}%` }}
												/>
											</div>
											<p class="text-xs text-center text-gray-500">
												正在下载{" "}
												{
													MODEL_OPTIONS.find(
														(m) => m.name === downloadingModel(),
													)?.label
												}
												：{Math.round(downloadProgress())}%
											</p>
										</div>
									</Show>
								</div>

								{/* Language Selection */}
								<Subfield name="语言">
									<KSelect<string>
										options={LANGUAGE_OPTIONS.map((l) => l.code)}
										value={selectedLanguage()}
										onChange={(value: string | null) => {
											if (value) setSelectedLanguage(value);
										}}
										itemComponent={(props) => (
											<MenuItem<typeof KSelect.Item>
												as={KSelect.Item}
												item={props.item}
											>
												<KSelect.ItemLabel class="flex-1">
													{
														LANGUAGE_OPTIONS.find(
															(l) => l.code === props.item.rawValue,
														)?.label
													}
												</KSelect.ItemLabel>
											</MenuItem>
										)}
									>
										<KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
											<KSelect.Value<string> class="flex-1 text-left truncate">
												{(state) => {
													const language = LANGUAGE_OPTIONS.find(
														(l) => l.code === state.selectedOption(),
													);
													return (
														<span>
															{language?.label || "选择语言"}
														</span>
													);
												}}
											</KSelect.Value>
											<KSelect.Icon>
												<IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180" />
											</KSelect.Icon>
										</KSelect.Trigger>
										<KSelect.Portal>
											<PopperContent<typeof KSelect.Content>
												as={KSelect.Content}
												class={topLeftAnimateClasses}
											>
												<MenuItemList<typeof KSelect.Listbox>
													class="max-h-48 overflow-y-auto"
													as={KSelect.Listbox}
												/>
											</PopperContent>
										</KSelect.Portal>
									</KSelect>
								</Subfield>

								{/* Generate Captions Button */}
								<Show when={hasAudio()}>
									<Button
										onClick={generateCaptions}
										disabled={isGenerating()}
										class="w-full"
									>
										{isGenerating() ? "正在生成..." : "生成字幕"}
									</Button>
								</Show>

								{/* Font & Style Settings */}
								<Field name="字体设计">
									<div class="space-y-3">
										<div class="flex flex-row justify-between items-center">
											<span class="text-xs text-gray-500">字体</span>
											<KSelect<string>
												options={fontOptions.map((f) => f.value)}
												value={captionSettings.font}
												onChange={(value) => {
													if (value === null) return;
													updateCaptionSetting("font", value);
												}}
												itemComponent={(props) => (
													<MenuItem<typeof KSelect.Item>
														as={KSelect.Item}
														item={props.item}
													>
														<KSelect.ItemLabel class="flex-1">
															{fontOptions.find((f) => f.value === props.item.rawValue)?.label}
														</KSelect.ItemLabel>
													</MenuItem>
												)}
											>
												<KSelect.Trigger class="flex flex-row items-center h-8 px-2 gap-1 border rounded-lg border-gray-200 w-[140px] text-gray-700 text-xs">
													<KSelect.Value<string> class="flex-1 text-left truncate">
														{(state) => fontOptions.find((f) => f.value === state.selectedOption())?.label}
													</KSelect.Value>
													<KSelect.Icon><IconCapChevronDown class="size-3 shrink-0" /></KSelect.Icon>
												</KSelect.Trigger>
												<KSelect.Portal>
													<PopperContent<typeof KSelect.Content> as={KSelect.Content} class={topLeftAnimateClasses}>
														<MenuItemList<typeof KSelect.Listbox> class="max-h-48 overflow-y-auto" as={KSelect.Listbox} />
													</PopperContent>
												</KSelect.Portal>
											</KSelect>
										</div>

										<div class="flex flex-row justify-between items-center">
											<span class="text-xs text-gray-500">大小</span>
											<div class="w-[140px]">
												<Slider
													value={[captionSettings.size || 24]}
													onChange={(v) => updateCaptionSetting("size", v[0])}
													minValue={12}
													maxValue={48}
													step={1}
												/>
											</div>
										</div>

										<div class="flex flex-row justify-between items-center">
											<span class="text-xs text-gray-500">字体颜色</span>
											<RgbInput
												value={captionSettings.color || "#FFFFFF"}
												onChange={(value) => updateCaptionSetting("color", value)}
											/>
										</div>

										<div class="flex flex-row justify-between items-center">
											<span class="text-xs text-gray-500">背景颜色</span>
											<RgbInput
												value={captionSettings.backgroundColor || "#000000"}
												onChange={(value) => updateCaptionSetting("backgroundColor", value)}
											/>
										</div>

										<div class="flex flex-row justify-between items-center">
											<span class="text-xs text-gray-500">背景不透明度</span>
											<div class="w-[140px]">
												<Slider
													value={[captionSettings.backgroundOpacity || 80]}
													onChange={(v) => updateCaptionSetting("backgroundOpacity", v[0])}
													minValue={0}
													maxValue={100}
													step={1}
												/>
											</div>
										</div>

										<div class="flex flex-row justify-between items-center">
											<span class="text-xs text-gray-500">位置</span>
											<KSelect<string>
												options={["top", "middle", "bottom"]}
												value={captionSettings.position || "bottom"}
												onChange={(value) => {
													if (value === null) return;
													updateCaptionSetting("position", value);
												}}
												itemComponent={(props) => (
													<MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
														<KSelect.ItemLabel class="flex-1 capitalize">{props.item.rawValue}</KSelect.ItemLabel>
													</MenuItem>
												)}
											>
												<KSelect.Trigger class="flex flex-row items-center h-8 px-2 gap-1 border rounded-lg border-gray-200 w-[140px] text-gray-700 text-xs">
													<KSelect.Value<string> class="flex-1 text-left truncate capitalize">
														{(state) => {
															const labels: Record<string, string> = { top: "顶部", middle: "中间", bottom: "底部" };
															return labels[state.selectedOption() ?? "bottom"] ?? state.selectedOption();
														}}
													</KSelect.Value>
													<KSelect.Icon><IconCapChevronDown class="size-3 shrink-0" /></KSelect.Icon>
												</KSelect.Trigger>
												<KSelect.Portal>
													<PopperContent<typeof KSelect.Content> as={KSelect.Content} class={topLeftAnimateClasses}>
														<MenuItemList<typeof KSelect.Listbox> as={KSelect.Listbox} />
													</PopperContent>
												</KSelect.Portal>
											</KSelect>
										</div>
									</div>
								</Field>

								{/* Style Options */}
								<Field name="样式选项">
									<div class="space-y-3">
										<div class="flex flex-col gap-4">
											<div class="flex flex-row justify-between items-center">
												<span class="text-xs text-gray-500">粗体</span>
												<Toggle
													checked={captionSettings.bold}
													onChange={(checked) =>
														updateCaptionSetting("bold", checked)
													}
												/>
											</div>
											<div class="flex flex-row justify-between items-center">
												<span class="text-xs text-gray-500">斜体</span>
												<Toggle
													checked={captionSettings.italic}
													onChange={(checked) =>
														updateCaptionSetting("italic", checked)
													}
												/>
											</div>
											<div class="flex flex-row justify-between items-center">
												<span class="text-xs text-gray-500">描边</span>
												<Toggle
													checked={captionSettings.outline}
													onChange={(checked) =>
														updateCaptionSetting("outline", checked)
													}
												/>
											</div>
										</div>

										<Show when={captionSettings.outline}>
											<div class="flex flex-row justify-between items-center">
												<span class="text-xs text-gray-500">描边颜色</span>
												<RgbInput
													value={captionSettings.outlineColor || "#000000"}
													onChange={(value) =>
														updateCaptionSetting("outlineColor", value)
													}
												/>
											</div>
										</Show>
									</div>
								</Field>

								{/* Export Options */}
								<Field name="导出选项">
									<div class="flex flex-row justify-between items-center">
										<span class="text-xs text-gray-500">导出时包含字幕</span>
										<Toggle
											checked={captionSettings.exportWithSubtitles}
											onChange={(checked) =>
												updateCaptionSetting("exportWithSubtitles", checked)
											}
										/>
									</div>
								</Field>

								{/* Caption Segments Section */}
								<Show when={project.captions?.segments.length}>
									<Field name="字幕片段">
										<div class="space-y-4">
											<div class="flex items-center justify-between">
												<Button
													onClick={() => addSegment(editorState.playbackTime)}
													class="w-full"
												>
													在当前时间添加
												</Button>
											</div>

											<div class="max-h-[300px] overflow-y-auto space-y-2 pr-2">
												{project.captions?.segments.length === 0 ? (
													<p class="text-sm text-gray-500">
														未找到字幕片段。
													</p>
												) : (
													project.captions?.segments.map((segment) => (
														<div class="relative bg-gray-50 dark:bg-gray-100 border border-gray-200 rounded-lg px-2 py-1.5 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 transition-colors">
															<textarea
																class="w-full resize-none outline-none bg-transparent text-xs text-[--text-primary] pr-5 pb-4 leading-tight"
																value={segment.text}
																rows={1}
																onChange={(e) =>
																	updateSegment(segment.id, {
																		text: e.target.value,
																	})
																}
															/>
															<button
																class="absolute bottom-2 right-2 p-1 text-gray-400 hover:text-red-500 transition-colors rounded"
																onClick={() => deleteSegment(segment.id)}
															>
																<IconDelete />
															</button>
														</div>
													))
												)}
											</div>
										</div>
									</Field>
								</Show>
							</div>
						</Show>
					</div>
			</div>
		</div>
	);
}

function IconDelete() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			class="size-4"
		>
			<path
				d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
				fill="currentColor"
			/>
		</svg>
	);
}
