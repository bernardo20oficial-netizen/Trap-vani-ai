import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Check,
  Clock,
  FolderOpen,
  FolderPlus,
  Globe,
  Loader2,
  Lock,
  Package,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Unlock,
  Upload,
  Volume2,
} from 'lucide-react';
import {
  ARTIST_808_CATEGORIES,
  MODERN_808_CATEGORIES,
  REFERENCE_ARTISTS,
  SONIC_PROFILES_808,
} from '../audio/library808';
import { Ai808Recommendation, Pack808, Sample808 } from '../types/studio';

export interface Import808Feedback {
  addedCount: number;
  skippedDuplicates: number;
  skippedInvalid: number;
}

interface Library808PanelProps {
  samples: Sample808[];
  packs: Pack808[];
  selected808Id: string;
  lock808Selection: boolean;
  auto808Mode: boolean;
  aiRecommendations: Ai808Recommendation[];
  aiRecSummary: string | null;
  aiRecBusy: boolean;
  aiRecError: string | null;
  onSelect808: (id: string) => void;
  onPreview808: (sample: Sample808, midiNote: number) => Promise<void>;
  onToggleLock808: () => void;
  onToggleAuto808Mode: () => void;
  onRequestAiRecommendations: () => Promise<void>;
  onImportFiles808: (params: {
    files: File[];
    packId: string;
    packName: string;
    category: string;
    sonority: string;
    rootNote: number;
    license: string;
    tags: string[];
  }) => Promise<Import808Feedback>;
  onCreatePack808: (params: {
    name: string;
    description: string;
    category: string;
    license: string;
    files: File[];
  }) => Promise<Import808Feedback>;
  onImportExternalPackUrl: (
    manifestUrl: string
  ) => Promise<Import808Feedback & { packName: string }>;
  onDeleteCustom808: (id: string) => Promise<void>;
  onDeleteCustomPack: (packId: string) => Promise<void>;
}

const PREVIEW_NOTES: Array<{ midi: number; label: string }> = [
  { midi: 36, label: 'C2' },
  { midi: 39, label: 'D#2' },
  { midi: 41, label: 'F2' },
  { midi: 43, label: 'G2' },
];

const AUDIO_FILE_RE = /\.(wav|mp3|m4a|ogg|flac|aac|opus)$/i;

function filterAudioFiles(fileList: FileList | null): File[] {
  if (!fileList) return [];
  return Array.from(fileList).filter(
    (f) => f.type.startsWith('audio/') || AUDIO_FILE_RE.test(f.name)
  );
}

const CREATE_CUSTOM_CAT_VALUE = '__custom_new_category__';

export const Library808Panel: React.FC<Library808PanelProps> = ({
  samples,
  packs,
  selected808Id,
  lock808Selection,
  auto808Mode,
  aiRecommendations,
  aiRecSummary,
  aiRecBusy,
  aiRecError,
  onSelect808,
  onPreview808,
  onToggleLock808,
  onToggleAuto808Mode,
  onRequestAiRecommendations,
  onImportFiles808,
  onCreatePack808,
  onImportExternalPackUrl,
  onDeleteCustom808,
  onDeleteCustomPack,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [libraryScope, setLibraryScope] = useState<'all' | 'classic' | 'artists'>('all');
  const [artistFilter, setArtistFilter] = useState<string>('todos');
  const [sonicFilter, setSonicFilter] = useState<string>('todos');
  const [categoryFilter, setCategoryFilter] = useState<string>('Todas');
  const [packFilter, setPackFilter] = useState<string>('todos');
  const [previewMidi, setPreviewMidi] = useState<number>(36);

  const [playingSampleId, setPlayingSampleId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [importNotice, setImportNotice] = useState<{
    type: 'ok' | 'err';
    text: string;
  } | null>(null);

  const [activeDrawer, setActiveDrawer] = useState<'none' | 'import' | 'pack' | 'external'>('none');

  // Import files state
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importTargetPackId, setImportTargetPackId] = useState<string>('pack_imported_phone');
  const [importCategoryChoice, setImportCategoryChoice] = useState<string>('Trap Americano Moderno');
  const [importCustomCategory, setImportCustomCategory] = useState<string>('');
  const [importSonority, setImportSonority] = useState<string>('Sample Próprio / WAV');
  const [importRootMidi, setImportRootMidi] = useState<number>(36);
  const [importLicense, setImportLicense] = useState('Ficheiro Próprio / Sample Licenciado');
  const [importTagsText, setImportTagsText] = useState('próprio, telefone');
  const [importBusy, setImportBusy] = useState(false);

  // New Pack state
  const [packName, setPackName] = useState('');
  const [packDescription, setPackDescription] = useState('');
  const [packCategoryChoice, setPackCategoryChoice] = useState<string>('Trap Americano Moderno');
  const [packCustomCategory, setPackCustomCategory] = useState<string>('');
  const [packLicense, setPackLicense] = useState('Pacote Próprio / Royalty-Free');
  const [packFiles, setPackFiles] = useState<File[]>([]);
  const [packBusy, setPackBusy] = useState(false);

  // External licensed JSON pack URL state
  const [externalManifestUrl, setExternalManifestUrl] = useState('');
  const [externalBusy, setExternalBusy] = useState(false);

  const importFileRef = useRef<HTMLInputElement | null>(null);
  const importFolderRef = useRef<HTMLInputElement | null>(null);
  const packFilesRef = useRef<HTMLInputElement | null>(null);
  const packFolderRef = useRef<HTMLInputElement | null>(null);
  const playTimerRef = useRef<number | null>(null);

  const selectedSample =
    samples.find((s) => s.id === selected808Id && s.available) ||
    samples.find((s) => s.available) ||
    samples[0];

  const availableCount = useMemo(
    () => samples.filter((s) => s.available).length,
    [samples]
  );

  const artistSamplesCount = useMemo(
    () => samples.filter((s) => Boolean(s.artistRef) && s.available).length,
    [samples]
  );

  const classicSamplesCount = useMemo(
    () => samples.filter((s) => !s.artistRef && s.available).length,
    [samples]
  );

  // Dynamic categories respecting separated Classic vs Artist collections
  const allCategories = useMemo(() => {
    const set = new Set<string>();
    if (libraryScope !== 'artists') {
      for (const c of MODERN_808_CATEGORIES) set.add(c);
    }
    if (libraryScope !== 'classic') {
      for (const c of ARTIST_808_CATEGORIES) set.add(c);
    }
    for (const s of samples) {
      if (libraryScope === 'classic' && s.artistRef) continue;
      if (libraryScope === 'artists' && !s.artistRef) continue;
      if (s.category) set.add(s.category);
      if (s.style) set.add(s.style);
    }
    return Array.from(set);
  }, [samples, libraryScope]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return samples.filter((s) => {
      if (libraryScope === 'classic' && s.artistRef) return false;
      if (libraryScope === 'artists' && !s.artistRef) return false;

      if (artistFilter !== 'todos' && s.artistRef !== artistFilter) return false;

      if (sonicFilter !== 'todos') {
        const cats = new Set<string>([
          s.category,
          s.style,
          ...(s.categories || []),
        ]);
        const shortKeyword = sonicFilter.replace(/^808\s+/i, '').toLowerCase();
        const matchesCat = cats.has(sonicFilter);
        const matchesHay = [s.sonicProfile || '', s.sonority, s.name, ...(s.tags || [])]
          .join(' ')
          .toLowerCase()
          .includes(shortKeyword);
        if (!matchesCat && !matchesHay) return false;
      }

      if (categoryFilter !== 'Todas') {
        const cats = new Set<string>([
          s.category,
          s.style,
          ...(s.categories || []),
        ]);
        if (!cats.has(categoryFilter)) return false;
      }
      if (packFilter !== 'todos' && s.packId !== packFilter) return false;
      if (q) {
        const hay = [
          s.name,
          s.artistRef || '',
          s.songRef || '',
          s.sonicProfile || '',
          s.category,
          ...(s.categories || []),
          s.character,
          s.style,
          s.sonority,
          s.packName,
          s.license,
          ...(s.tags || []),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [samples, searchQuery, libraryScope, artistFilter, sonicFilter, categoryFilter, packFilter]);

  const compareSamples = useMemo(
    () =>
      compareIds
        .map((id) => samples.find((s) => s.id === id && s.available))
        .filter((s): s is Sample808 => Boolean(s)),
    [compareIds, samples]
  );

  const toggleCompare = (id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  };

  const triggerAudition = async (sample: Sample808) => {
    if (!sample.available) return;
    setPreviewError(null);
    setPlayingSampleId(sample.id);
    if (playTimerRef.current !== null) {
      clearTimeout(playTimerRef.current);
    }
    try {
      await onPreview808(sample, previewMidi);
      const ms = Math.min(2400, Math.max(450, Math.round((sample.durationSec || 1.1) * 1000)));
      playTimerRef.current = window.setTimeout(() => {
        setPlayingSampleId((curr) => (curr === sample.id ? null : curr));
      }, ms);
    } catch (err) {
      setPlayingSampleId(null);
      setPreviewError(
        err instanceof Error ? err.message : `Não foi possível reproduzir "${sample.name}".`
      );
    }
  };

  const formatImportSummary = (res: Import808Feedback, prefix: string) => {
    const parts = [`${res.addedCount} som(ns) adicionado(s)`];
    if (res.skippedDuplicates > 0) {
      parts.push(`${res.skippedDuplicates} duplicado(s) ignorado(s)`);
    }
    if (res.skippedInvalid > 0) {
      parts.push(`${res.skippedInvalid} ficheiro(s) inválido(s)`);
    }
    return `${prefix}: ${parts.join(' · ')}.`;
  };

  const handleSaveImportedFiles = async () => {
    if (importFiles.length === 0) return;
    const resolvedCategory =
      importCategoryChoice === CREATE_CUSTOM_CAT_VALUE
        ? importCustomCategory.trim() || 'Categoria Personalizada'
        : importCategoryChoice;

    setImportBusy(true);
    setImportNotice(null);
    try {
      const targetPack = packs.find((p) => p.id === importTargetPackId);
      const packNameResolved = targetPack?.name || 'Importados do Telefone';
      const tags = importTagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const summary = await onImportFiles808({
        files: importFiles,
        packId: importTargetPackId,
        packName: packNameResolved,
        category: resolvedCategory,
        sonority: importSonority.trim() || 'Personalizado',
        rootNote: importRootMidi,
        license: importLicense.trim() || 'Sample Importado pelo Artista',
        tags,
      });
      setImportNotice({
        type: summary.addedCount > 0 ? 'ok' : 'err',
        text: formatImportSummary(summary, 'Importação concluída'),
      });
      setImportFiles([]);
      setImportCustomCategory('');
      setActiveDrawer('none');
      setCategoryFilter('Todas');
      setPackFilter('todos');
    } catch (err) {
      setImportNotice({
        type: 'err',
        text: err instanceof Error ? err.message : 'Erro ao importar ficheiros 808.',
      });
    } finally {
      setImportBusy(false);
    }
  };

  const handleCreatePack = async () => {
    if (!packName.trim()) return;
    const resolvedCategory =
      packCategoryChoice === CREATE_CUSTOM_CAT_VALUE
        ? packCustomCategory.trim() || 'Categoria Personalizada'
        : packCategoryChoice;

    setPackBusy(true);
    setImportNotice(null);
    try {
      const summary = await onCreatePack808({
        name: packName.trim(),
        description: packDescription.trim() || 'Pacote expansível de 808.',
        category: resolvedCategory,
        license: packLicense.trim() || 'Pacote Próprio / Royalty-Free',
        files: packFiles,
      });
      setImportNotice({
        type: 'ok',
        text:
          packFiles.length > 0
            ? formatImportSummary(summary, `Pacote "${packName.trim()}" criado`)
            : `Pacote "${packName.trim()}" criado e pronto para receber samples.`,
      });
      setPackName('');
      setPackDescription('');
      setPackCustomCategory('');
      setPackFiles([]);
      setActiveDrawer('none');
    } catch (err) {
      setImportNotice({
        type: 'err',
        text: err instanceof Error ? err.message : 'Erro ao criar pacote.',
      });
    } finally {
      setPackBusy(false);
    }
  };

  const handleLoadExternalPack = async () => {
    if (!externalManifestUrl.trim()) return;
    setExternalBusy(true);
    setImportNotice(null);
    try {
      const summary = await onImportExternalPackUrl(externalManifestUrl.trim());
      setImportNotice({
        type: 'ok',
        text: formatImportSummary(summary, `Pack externo "${summary.packName}" importado`),
      });
      setExternalManifestUrl('');
      setActiveDrawer('none');
      setCategoryFilter('Todas');
      setPackFilter('todos');
    } catch (err) {
      setImportNotice({
        type: 'err',
        text: err instanceof Error ? err.message : 'Falha ao importar pacote externo.',
      });
    } finally {
      setExternalBusy(false);
    }
  };

  return (
    <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
            Biblioteca Profissional de 808
          </h3>
          <p className="text-xs sm:text-sm text-[#949CAE] mt-0.5">
            {availableCount} samples reais e distintos em {allCategories.length} categorias.{' '}
            <span className="text-[#CBD2DF]">Ouvir Demo</span> reproduz apenas o 808 selecionado.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              setActiveDrawer((d) => (d === 'import' ? 'none' : 'import'))
            }
            className={`min-h-[44px] px-3.5 py-2 rounded-xl border text-xs sm:text-sm font-medium flex items-center gap-2 cursor-pointer whitespace-nowrap ${
              activeDrawer === 'import'
                ? 'bg-amber-500 text-[#0A0B0E] border-amber-500 font-semibold'
                : 'bg-[#1A1D26] hover:bg-[#232734] border-[#2D3342] text-[#F4F4F6]'
            }`}
          >
            <Upload className="w-4 h-4 shrink-0" />
            <span>Importar do Telefone</span>
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveDrawer((d) => (d === 'pack' ? 'none' : 'pack'))
            }
            className={`min-h-[44px] px-3.5 py-2 rounded-xl border text-xs sm:text-sm font-medium flex items-center gap-2 cursor-pointer whitespace-nowrap ${
              activeDrawer === 'pack'
                ? 'bg-amber-500 text-[#0A0B0E] border-amber-500 font-semibold'
                : 'bg-[#1A1D26] hover:bg-[#232734] border-[#2D3342] text-[#F4F4F6]'
            }`}
          >
            <FolderPlus className="w-4 h-4 shrink-0" />
            <span>Novo Pacote</span>
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveDrawer((d) => (d === 'external' ? 'none' : 'external'))
            }
            className={`min-h-[44px] px-3.5 py-2 rounded-xl border text-xs sm:text-sm font-medium flex items-center gap-2 cursor-pointer whitespace-nowrap ${
              activeDrawer === 'external'
                ? 'bg-amber-500 text-[#0A0B0E] border-amber-500 font-semibold'
                : 'bg-[#1A1D26] hover:bg-[#232734] border-[#2D3342] text-[#F4F4F6]'
            }`}
          >
            <Globe className="w-4 h-4 shrink-0" />
            <span>Pack Externo (URL)</span>
          </button>
        </div>
      </div>

      {importNotice && (
        <div
          className={`text-xs sm:text-sm rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2 border ${
            importNotice.type === 'ok'
              ? 'bg-emerald-950/35 border-emerald-700/50 text-emerald-200'
              : 'bg-red-950/40 border-red-800/60 text-red-200'
          }`}
        >
          <span>{importNotice.text}</span>
          <button
            type="button"
            onClick={() => setImportNotice(null)}
            className="text-xs underline shrink-0 cursor-pointer"
          >
            Fechar
          </button>
        </div>
      )}

      {/* Currently Selected 808 + Explicit Artist Lock + Optional AI Auto Mode */}
      <div className="bg-[#0D0F14] border border-[#252A36] rounded-xl p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-[#949CAE]">808 Ativo no Projeto</div>
            <div className="text-sm sm:text-base font-semibold text-amber-400 truncate mt-0.5">
              {selectedSample?.name}
            </div>
            <div className="text-xs text-[#6B7385] mt-0.5 truncate">
              {selectedSample?.category} · {selectedSample?.sonority} · {selectedSample?.license}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!selectedSample?.available}
              onClick={() => selectedSample && void triggerAudition(selectedSample)}
              className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#1A1D26] hover:bg-[#232734] border border-[#2D3342] text-xs font-semibold text-[#F4F4F6] flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              {playingSampleId === selectedSample?.id ? (
                <Volume2 className="w-3.5 h-3.5 text-amber-400" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-current text-amber-400" />
              )}
              <span>
                {playingSampleId === selectedSample?.id ? 'A tocar 808...' : 'Ouvir Demo'}
              </span>
            </button>

            <button
              type="button"
              disabled={aiRecBusy}
              onClick={onRequestAiRecommendations}
              className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#1A1D26] hover:bg-[#232734] disabled:opacity-50 border border-[#2D3342] text-xs font-semibold text-amber-300 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              {aiRecBusy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>IA Recomenda 808</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-[#1C202B]">
          <button
            type="button"
            onClick={onToggleLock808}
            className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
              lock808Selection
                ? 'bg-amber-500 text-[#0A0B0E]'
                : 'bg-[#1A1D26] text-[#CBD2DF] border border-[#2D3342]'
            }`}
          >
            {lock808Selection ? (
              <Lock className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <Unlock className="w-3.5 h-3.5 shrink-0" />
            )}
            <span>
              {lock808Selection
                ? 'Escolha Manual Protegida (IA não troca)'
                : 'Escolha Livre (Pode desbloquear)'}
            </span>
          </button>

          <button
            type="button"
            disabled={lock808Selection}
            onClick={onToggleAuto808Mode}
            title={
              lock808Selection
                ? 'Desbloqueie a escolha manual primeiro para permitir seleção automática pela IA'
                : 'Autorizar a IA a escolher automaticamente o 808 ao analisar voz/beat'
            }
            className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 cursor-pointer whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed ${
              auto808Mode && !lock808Selection
                ? 'bg-amber-500/20 border border-amber-500 text-amber-300'
                : 'bg-[#13151B] border border-[#252A36] text-[#949CAE]'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            <span>
              {lock808Selection
                ? 'IA Auto-808 Bloqueado pela sua escolha'
                : auto808Mode
                  ? 'IA Auto-808: Autorizado'
                  : 'Autorizar IA a Escolher 808'}
            </span>
          </button>
        </div>
      </div>

      {/* Side-by-Side Comparison Strip */}
      {compareSamples.length > 0 && (
        <div className="bg-[#0D0F14] border border-amber-500/35 rounded-xl p-3.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
              <ArrowLeftRight className="w-3.5 h-3.5" />
              <span>Comparador Direto de 808 ({compareSamples.length}/2)</span>
            </div>
            <button
              type="button"
              onClick={() => setCompareIds([])}
              className="text-xs text-[#949CAE] hover:text-white cursor-pointer"
            >
              Limpar comparação
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {compareSamples.map((cs, idx) => {
              const isSelected = cs.id === selected808Id;
              return (
                <div
                  key={cs.id}
                  className="bg-[#13151B] border border-[#252A36] rounded-xl p-3 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-[11px] text-[#949CAE] font-mono-tabular">
                      Opção {idx === 0 ? 'A' : 'B'} · {(cs.durationSec ?? cs.subDecay).toFixed(2)}s
                    </div>
                    <div className="text-xs font-semibold text-[#F4F4F6] truncate">{cs.name}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void triggerAudition(cs)}
                      className="min-h-[38px] px-2.5 rounded-lg bg-[#1A1D26] border border-[#2D3342] text-xs font-medium text-[#F4F4F6] flex items-center gap-1 cursor-pointer"
                    >
                      <Play className="w-3 h-3 fill-current text-amber-400" />
                      <span>Ouvir Demo</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelect808(cs.id)}
                      className={`min-h-[38px] px-2.5 rounded-lg text-xs font-semibold cursor-pointer ${
                        isSelected
                          ? 'bg-amber-500 text-[#0A0B0E]'
                          : 'bg-[#222736] hover:bg-amber-500 hover:text-[#0A0B0E] text-[#E2E6EE]'
                      }`}
                    >
                      {isSelected ? 'Ativo' : 'Escolher'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {previewError && (
        <div className="text-xs sm:text-sm text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3.5 py-2.5">
          {previewError}
        </div>
      )}

      {aiRecError && (
        <div className="text-xs sm:text-sm text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3.5 py-2.5">
          {aiRecError}
        </div>
      )}

      {/* AI Recommendations Panel */}
      {aiRecommendations.length > 0 && (
        <div className="bg-[#0D0F14] border border-amber-500/35 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-amber-300">
              Sugestões da IA (Nunca substitui a sua escolha sem autorização)
            </div>
            {aiRecSummary && (
              <span className="text-xs text-[#949CAE]">{aiRecSummary}</span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2.5">
            {aiRecommendations.map((rec) => {
              const sample = samples.find((s) => s.id === rec.sampleId && s.available);
              if (!sample) return null;
              const isCurrent = sample.id === selected808Id;
              return (
                <div
                  key={rec.sampleId}
                  className="bg-[#13151B] border border-[#252A36] rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-sm font-semibold text-[#F4F4F6]">
                      {sample.name}{' '}
                      <span className="text-xs font-normal text-[#949CAE]">
                        · {sample.category}
                      </span>
                    </div>
                    <p className="text-xs text-[#CBD2DF]">{rec.reasonPt}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void triggerAudition(sample)}
                      className="min-h-[40px] px-3 py-1.5 rounded-lg bg-[#1A1D26] border border-[#2D3342] text-xs font-medium text-[#F4F4F6] flex items-center gap-1.5 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 fill-current text-amber-400" />
                      <span>Ouvir Demo</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelect808(sample.id)}
                      className={`min-h-[40px] px-3.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap ${
                        isCurrent
                          ? 'bg-amber-500 text-[#0A0B0E]'
                          : 'bg-amber-500/20 hover:bg-amber-500 hover:text-[#0A0B0E] text-amber-300 border border-amber-500/40'
                      }`}
                    >
                      {isCurrent ? 'Em Uso' : 'Autorizar e Usar'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Drawer 1: Import 808 files from phone (unlimited categories) */}
      {activeDrawer === 'import' && (
        <div className="bg-[#0D0F14] border border-amber-500/35 rounded-xl p-4 space-y-3">
          <div className="text-sm font-semibold text-[#F4F4F6]">
            Importar Ficheiros 808 do Telefone ou Computador
          </div>
          <p className="text-xs text-[#949CAE]">
            Carregue ficheiros WAV, MP3, M4A ou OGG próprios ou devidamente licenciados. Pode escolher qualquer categoria ou criar uma nova.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-[#949CAE] mb-1">Pacote de Destino</label>
              <select
                value={importTargetPackId}
                onChange={(e) => setImportTargetPackId(e.target.value)}
                className="w-full min-h-[44px] bg-[#13151B] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
              >
                <option value="pack_imported_phone">Importados do Telefone</option>
                {packs
                  .filter((p) => p.isCustom)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-[#949CAE] mb-1">Categoria</label>
              <select
                value={importCategoryChoice}
                onChange={(e) => setImportCategoryChoice(e.target.value)}
                className="w-full min-h-[44px] bg-[#13151B] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
              >
                {allCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
                <option value={CREATE_CUSTOM_CAT_VALUE}>+ Criar nova categoria...</option>
              </select>
            </div>

            {importCategoryChoice === CREATE_CUSTOM_CAT_VALUE ? (
              <div>
                <label className="block text-xs text-amber-300 mb-1">Nome da Nova Categoria</label>
                <input
                  type="text"
                  value={importCustomCategory}
                  onChange={(e) => setImportCustomCategory(e.target.value)}
                  placeholder="Ex: Afro Trap, Jersey Club..."
                  className="w-full min-h-[44px] bg-[#13151B] border border-amber-500/50 rounded-xl px-3 text-sm text-[#F4F4F6]"
                />
              </div>
            ) : (
              <div>
                <label className="block text-xs text-[#949CAE] mb-1">Descrição Sonora</label>
                <input
                  type="text"
                  value={importSonority}
                  onChange={(e) => setImportSonority(e.target.value)}
                  placeholder="Ex: Sub limpo e seco"
                  className="w-full min-h-[44px] bg-[#13151B] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
                />
              </div>
            )}

            <div>
              <label className="block text-xs text-[#949CAE] mb-1">Nota Base Original</label>
              <select
                value={importRootMidi}
                onChange={(e) => setImportRootMidi(Number(e.target.value))}
                className="w-full min-h-[44px] bg-[#13151B] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
              >
                <option value={36}>C2 (Padrão)</option>
                <option value={33}>A1</option>
                <option value={31}>G1</option>
                <option value={38}>D2</option>
                <option value={40}>E2</option>
                <option value={41}>F2</option>
                <option value={43}>G2</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[#949CAE] mb-1">Origem / Licença</label>
              <input
                type="text"
                value={importLicense}
                onChange={(e) => setImportLicense(e.target.value)}
                placeholder="Ex: Royalty-Free / Gravação Própria"
                className="w-full min-h-[44px] bg-[#13151B] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
              />
            </div>
            <div>
              <label className="block text-xs text-[#949CAE] mb-1">
                Tags de Pesquisa (separadas por vírgula)
              </label>
              <input
                type="text"
                value={importTagsText}
                onChange={(e) => setImportTagsText(e.target.value)}
                placeholder="Ex: pesado, curto, grave forte"
                className="w-full min-h-[44px] bg-[#13151B] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={importFileRef}
              type="file"
              accept="audio/*"
              multiple
              onChange={(e) => setImportFiles(filterAudioFiles(e.target.files))}
              className="hidden"
            />
            <input
              ref={importFolderRef}
              type="file"
              multiple
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(e) => setImportFiles(filterAudioFiles(e.target.files))}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => importFileRef.current?.click()}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#1A1D26] border border-[#2D3342] text-sm text-[#E2E6EE] flex items-center gap-2 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              <span>
                {importFiles.length > 0
                  ? `${importFiles.length} áudio(s) pronto(s)`
                  : 'Selecionar Ficheiros'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => importFolderRef.current?.click()}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#1A1D26] border border-[#2D3342] text-sm text-[#E2E6EE] flex items-center gap-2 cursor-pointer"
            >
              <FolderOpen className="w-4 h-4 text-amber-400" />
              <span>Importar Pasta Completa</span>
            </button>

            <button
              type="button"
              disabled={importFiles.length === 0 || importBusy}
              onClick={handleSaveImportedFiles}
              className="min-h-[44px] px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-[#0A0B0E] font-semibold text-sm cursor-pointer"
            >
              {importBusy ? 'A verificar e importar...' : 'Adicionar à Biblioteca'}
            </button>
          </div>
        </div>
      )}

      {/* Drawer 2: Create New Expandable 808 Pack */}
      {activeDrawer === 'pack' && (
        <div className="bg-[#0D0F14] border border-amber-500/35 rounded-xl p-4 space-y-3">
          <div className="text-sm font-semibold text-[#F4F4F6]">
            Criar Novo Pacote de 808
          </div>
          <p className="text-xs text-[#949CAE]">
            Expanda a biblioteca sem limites com novos pacotes, novas categorias ou importando uma pasta inteira de samples licenciados (ex: Splice, Loopcloud ou kit próprio).
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[#949CAE] mb-1">Nome do Pacote</label>
              <input
                type="text"
                value={packName}
                onChange={(e) => setPackName(e.target.value)}
                placeholder="Ex: Pack Trap Lisboa Vol. 1"
                className="w-full min-h-[44px] bg-[#13151B] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
              />
            </div>

            <div>
              <label className="block text-xs text-[#949CAE] mb-1">Categoria do Pacote</label>
              <select
                value={packCategoryChoice}
                onChange={(e) => setPackCategoryChoice(e.target.value)}
                className="w-full min-h-[44px] bg-[#13151B] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
              >
                {allCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
                <option value={CREATE_CUSTOM_CAT_VALUE}>+ Criar nova categoria...</option>
              </select>
            </div>

            {packCategoryChoice === CREATE_CUSTOM_CAT_VALUE && (
              <div className="sm:col-span-2">
                <label className="block text-xs text-amber-300 mb-1">
                  Nome da Nova Categoria
                </label>
                <input
                  type="text"
                  value={packCustomCategory}
                  onChange={(e) => setPackCustomCategory(e.target.value)}
                  placeholder="Ex: Trap Brasileiro, Pluggnb, Boombap 808..."
                  className="w-full min-h-[44px] bg-[#13151B] border border-amber-500/50 rounded-xl px-3 text-sm text-[#F4F4F6]"
                />
              </div>
            )}

            <div>
              <label className="block text-xs text-[#949CAE] mb-1">Descrição</label>
              <input
                type="text"
                value={packDescription}
                onChange={(e) => setPackDescription(e.target.value)}
                placeholder="Ex: 808s pesados com corte médio para voz"
                className="w-full min-h-[44px] bg-[#13151B] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
              />
            </div>

            <div>
              <label className="block text-xs text-[#949CAE] mb-1">Licença do Pacote</label>
              <input
                type="text"
                value={packLicense}
                onChange={(e) => setPackLicense(e.target.value)}
                placeholder="Ex: Royalty-Free / Uso Comercial"
                className="w-full min-h-[44px] bg-[#13151B] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={packFilesRef}
              type="file"
              accept="audio/*"
              multiple
              onChange={(e) => setPackFiles(filterAudioFiles(e.target.files))}
              className="hidden"
            />
            <input
              ref={packFolderRef}
              type="file"
              multiple
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(e) => setPackFiles(filterAudioFiles(e.target.files))}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => packFilesRef.current?.click()}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#1A1D26] border border-[#2D3342] text-sm text-[#E2E6EE] flex items-center gap-2 cursor-pointer"
            >
              <Package className="w-4 h-4" />
              <span>
                {packFiles.length > 0
                  ? `${packFiles.length} áudio(s) no pacote`
                  : 'Selecionar Ficheiros (Opcional)'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => packFolderRef.current?.click()}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#1A1D26] border border-[#2D3342] text-sm text-[#E2E6EE] flex items-center gap-2 cursor-pointer"
            >
              <FolderOpen className="w-4 h-4 text-amber-400" />
              <span>Carregar Pasta do Pacote</span>
            </button>

            <button
              type="button"
              disabled={!packName.trim() || packBusy}
              onClick={handleCreatePack}
              className="min-h-[44px] px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-[#0A0B0E] font-semibold text-sm cursor-pointer"
            >
              {packBusy ? 'A criar pacote...' : 'Criar Pacote de 808'}
            </button>
          </div>
        </div>
      )}

      {/* Drawer 3: Import External Licensed 808 Pack via JSON Manifest URL */}
      {activeDrawer === 'external' && (
        <div className="bg-[#0D0F14] border border-amber-500/35 rounded-xl p-4 space-y-3">
          <div className="text-sm font-semibold text-[#F4F4F6]">
            Integrar Pacote Externo Licenciado (Manifesto JSON)
          </div>
          <p className="text-xs text-[#949CAE] leading-relaxed">
            Cole o URL público (HTTPS) de um ficheiro <code className="text-amber-300">pack.json</code> licenciado. O servidor verifica cada ligação de áudio, evita duplicados por SHA-256 e guarda os WAV/MP3 localmente no estúdio para tocar sem falhas.
          </p>

          <div className="flex flex-col sm:flex-row gap-2.5">
            <input
              type="url"
              value={externalManifestUrl}
              onChange={(e) => setExternalManifestUrl(e.target.value)}
              placeholder="https://exemplo.com/packs/trap-pack-808.json"
              className="flex-1 min-h-[44px] bg-[#13151B] border border-[#252A36] focus:border-amber-500 outline-none rounded-xl px-3 text-sm text-[#F4F4F6]"
            />
            <button
              type="button"
              disabled={!externalManifestUrl.trim() || externalBusy}
              onClick={handleLoadExternalPack}
              className="min-h-[44px] px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-[#0A0B0E] font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
            >
              {externalBusy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>A validar e transferir...</span>
                </>
              ) : (
                <span>Importar Pack Externo</span>
              )}
            </button>
          </div>

          <div className="bg-[#13151B] border border-[#222733] rounded-lg p-2.5 text-[11px] text-[#949CAE] font-mono-tabular overflow-x-auto">
            Formato JSON esperado:{' '}
            {`{ "name": "...", "style": "Dark Trap", "license": "Royalty-Free", "samples": [{ "name": "808 Sub", "audioUrl": "https://.../sub.wav", "rootNote": 36 }] }`}
          </div>
        </div>
      )}

      {/* Search Bar & Preview Note Selector */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-[#6B7385] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Pesquisar por 808, artista ou música (ex: Juice WRLD, Lucid Dreams, Carti, Yeat, SICKO MODE)..."
            className="w-full min-h-[44px] bg-[#0D0F14] border border-[#252A36] focus:border-amber-500 outline-none rounded-xl pl-10 pr-3 text-sm text-[#F4F4F6] placeholder:text-[#5F6778]"
          />
        </div>

        <div className="flex items-center gap-1 bg-[#0D0F14] border border-[#252A36] rounded-xl p-1 shrink-0">
          <span className="text-[11px] text-[#949CAE] px-2">Nota Demo:</span>
          {PREVIEW_NOTES.map((n) => (
            <button
              key={n.midi}
              type="button"
              onClick={() => setPreviewMidi(n.midi)}
              className={`min-h-[34px] px-2.5 rounded-lg text-xs font-mono-tabular font-semibold cursor-pointer ${
                previewMidi === n.midi
                  ? 'bg-amber-500 text-[#0A0B0E]'
                  : 'text-[#CBD2DF] hover:text-white'
              }`}
            >
              {n.label}
            </button>
          ))}
        </div>
      </div>

      {/* Separated Organization Tabs: Classic 72 vs Artist & Song References vs All */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0D0F14] border border-[#222733] rounded-xl p-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'all', label: `Todos os 808 (${availableCount})` },
              { id: 'classic', label: `Biblioteca Base (${classicSamplesCount})` },
              { id: 'artists', label: `Referências de Artistas & Músicas (${artistSamplesCount})` },
            ] as const
          ).map((scope) => (
            <button
              key={scope.id}
              type="button"
              onClick={() => {
                setLibraryScope(scope.id);
                setCategoryFilter('Todas');
                if (scope.id === 'classic') setArtistFilter('todos');
              }}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                libraryScope === scope.id
                  ? 'bg-amber-500 text-[#0A0B0E]'
                  : 'text-[#949CAE] hover:text-[#F4F4F6]'
              }`}
            >
              {scope.label}
            </button>
          ))}
        </div>

        {(artistFilter !== 'todos' || sonicFilter !== 'todos' || categoryFilter !== 'Todas' || packFilter !== 'todos') && (
          <button
            type="button"
            onClick={() => {
              setArtistFilter('todos');
              setSonicFilter('todos');
              setCategoryFilter('Todas');
              setPackFilter('todos');
              setSearchQuery('');
            }}
            className="text-xs text-amber-400 hover:underline px-2 cursor-pointer"
          >
            Limpar filtros
          </button>
        )}
      </div>

      {/* Artist References & Sonic Profile Filters */}
      {libraryScope !== 'classic' && (
        <div className="bg-[#0D0F14] border border-[#222733] rounded-xl p-3 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[#E2E6EE]">
              Artistas de Referência (Estética Inspirada — Samples Originais)
            </span>
            {artistFilter !== 'todos' && (
              <button
                type="button"
                onClick={() => setArtistFilter('todos')}
                className="text-[11px] text-amber-400 hover:underline cursor-pointer"
              >
                Ver todos os 16 artistas
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setArtistFilter('todos')}
              className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap ${
                artistFilter === 'todos'
                  ? 'bg-[#262C3B] text-white border border-[#3B445C]'
                  : 'bg-[#13151B] text-[#949CAE] border border-[#222733] hover:text-[#F4F4F6]'
              }`}
            >
              Todos os Artistas (16)
            </button>
            {REFERENCE_ARTISTS.map((artist) => (
              <button
                key={artist}
                type="button"
                onClick={() => {
                  setArtistFilter(artist);
                  if (libraryScope === 'all') setPackFilter('todos');
                }}
                className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap ${
                  artistFilter === artist
                    ? 'bg-amber-500 text-[#0A0B0E] font-semibold'
                    : 'bg-[#13151B] text-[#CBD2DF] border border-[#222733] hover:border-amber-500/40'
                }`}
              >
                {artist}
              </button>
            ))}
          </div>

          <div className="pt-2 border-t border-[#1B1F2A] flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-[#949CAE] mr-1">Perfil Sonoro:</span>
            <button
              type="button"
              onClick={() => setSonicFilter('todos')}
              className={`min-h-[32px] px-2.5 py-1 rounded-lg text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                sonicFilter === 'todos'
                  ? 'bg-[#262C3B] text-white'
                  : 'bg-[#13151B] text-[#949CAE] border border-[#222733]'
              }`}
            >
              Todos
            </button>
            {SONIC_PROFILES_808.map((prof) => (
              <button
                key={prof}
                type="button"
                onClick={() => setSonicFilter(prof)}
                className={`min-h-[32px] px-2.5 py-1 rounded-lg text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                  sonicFilter === prof
                    ? 'bg-amber-500/25 border border-amber-500 text-amber-300 font-semibold'
                    : 'bg-[#13151B] text-[#949CAE] border border-[#222733] hover:text-[#F4F4F6]'
                }`}
              >
                {prof}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filters: Pack Selector + Categories */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setPackFilter('todos')}
            className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
              packFilter === 'todos'
                ? 'bg-[#262C3B] text-white border border-[#3B445C]'
                : 'bg-[#0D0F14] text-[#949CAE] border border-[#222733]'
            }`}
          >
            Todos os Pacotes ({packs.length})
          </button>
          {packs.map((p) => (
            <div key={p.id} className="flex items-center shrink-0">
              <button
                type="button"
                onClick={() => setPackFilter(p.id)}
                className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                  packFilter === p.id
                    ? 'bg-[#262C3B] text-amber-300 border border-amber-500/40'
                    : 'bg-[#0D0F14] text-[#949CAE] border border-[#222733] hover:text-[#F4F4F6]'
                }`}
              >
                {p.name}
              </button>
              {p.isCustom && packFilter === p.id && (
                <button
                  type="button"
                  onClick={() => {
                    void onDeleteCustomPack(p.id);
                    setPackFilter('todos');
                  }}
                  title="Remover pacote personalizado"
                  className="ml-1 min-h-[36px] min-w-[36px] rounded-lg bg-[#1A1D26] hover:bg-red-950/60 text-[#949CAE] hover:text-red-300 flex items-center justify-center cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => setCategoryFilter('Todas')}
            className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
              categoryFilter === 'Todas'
                ? 'bg-amber-500 text-[#0A0B0E] font-semibold'
                : 'bg-[#0D0F14] text-[#949CAE] hover:text-[#F4F4F6] border border-[#222733]'
            }`}
          >
            Todas ({samples.length})
          </button>
          {allCategories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategoryFilter(cat)}
              className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                categoryFilter === cat
                  ? 'bg-amber-500 text-[#0A0B0E] font-semibold'
                  : 'bg-[#0D0F14] text-[#949CAE] hover:text-[#F4F4F6] border border-[#222733]'
              }`}
            >
              {cat}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setActiveDrawer('import')}
            className="min-h-[36px] px-3 py-1 rounded-lg text-xs font-medium bg-[#171A23] hover:bg-[#222735] text-amber-300 border border-dashed border-amber-500/40 flex items-center gap-1 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Nova Categoria</span>
          </button>
        </div>
      </div>

      {/* Results Count */}
      <div className="text-xs text-[#949CAE] font-mono-tabular">
        A mostrar {filtered.length} de {samples.length} entradas ({availableCount} samples distintos com áudio real)
      </div>

      {/* 808 Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[540px] overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <div className="col-span-full text-sm text-[#6B7385] py-8 text-center bg-[#0D0F14] rounded-xl border border-[#222733]">
            Nenhum 808 encontrado para os filtros atuais. Experimente limpar a pesquisa ou importar do telefone.
          </div>
        ) : (
          filtered.map((sample) => {
            const isSelected = sample.id === selected808Id;
            const isPlayingThis = playingSampleId === sample.id;
            const isComparing = compareIds.includes(sample.id);
            return (
              <div
                key={sample.id}
                className={`rounded-xl p-3.5 border transition-colors flex flex-col justify-between gap-3 ${
                  !sample.available
                    ? 'bg-[#0D0F14]/60 border-[#1D212B] opacity-75'
                    : isSelected
                      ? 'bg-[#191C24] border-amber-500/70'
                      : 'bg-[#0D0F14] border-[#222733] hover:border-[#32394A]'
                }`}
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm text-[#F4F4F6] truncate">
                      {sample.name}
                    </span>
                    <span
                      className={`text-xs font-medium shrink-0 ${
                        sample.available ? 'text-amber-400/90' : 'text-[#949CAE]'
                      }`}
                    >
                      {sample.available ? sample.category : 'Indisponível'}
                    </span>
                  </div>
                  {sample.artistRef && (
                    <div className="text-xs font-medium text-amber-300/95">
                      {sample.artistRef}
                      {sample.songRef ? ` · Ref: "${sample.songRef}"` : ''}
                      {sample.sonicProfile ? ` · ${sample.sonicProfile}` : ''}
                    </div>
                  )}
                  <div className="text-xs text-[#949CAE]">
                    {sample.sonority} · {sample.packName}
                  </div>
                  <p className="text-xs text-[#CBD2DF] leading-relaxed">{sample.character}</p>
                  <div className="text-[11px] text-[#6B7385] font-mono-tabular truncate">
                    {sample.available
                      ? `Duração ${(sample.durationSec ?? sample.subDecay).toFixed(2)}s · ${sample.license}`
                      : 'Sem ficheiro de áudio disponível'}
                  </div>
                </div>

                {sample.available ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void triggerAudition(sample)}
                      className={`min-h-[44px] px-3 py-2 rounded-xl border text-xs font-medium flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                        isPlayingThis
                          ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                          : 'bg-[#1A1D26] hover:bg-[#252A36] border-[#2D3342] text-[#F4F4F6]'
                      }`}
                    >
                      {isPlayingThis ? (
                        <Volume2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      ) : (
                        <Play className="w-3.5 h-3.5 fill-current text-amber-400 shrink-0" />
                      )}
                      <span>{isPlayingThis ? 'A tocar...' : 'Ouvir Demo'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onSelect808(sample.id)}
                      className={`flex-1 min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
                        isSelected
                          ? 'bg-amber-500 text-[#0A0B0E]'
                          : 'bg-[#1D212B] hover:bg-[#272D3B] text-[#E2E6EE]'
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5 shrink-0" />}
                      <span>{isSelected ? 'Selecionado' : 'Escolher'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => toggleCompare(sample.id)}
                      title="Adicionar ao comparador A/B"
                      className={`min-h-[44px] px-2.5 py-2 rounded-xl border text-xs font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap ${
                        isComparing
                          ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                          : 'bg-[#1A1D26] hover:bg-[#252A36] border-[#2D3342] text-[#949CAE]'
                      }`}
                    >
                      <ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />
                      <span className="hidden sm:inline">Comparar</span>
                    </button>

                    {sample.isCustom && (
                      <button
                        type="button"
                        onClick={() => onDeleteCustom808(sample.id)}
                        title="Remover 808 importado"
                        className="min-h-[44px] min-w-[44px] rounded-xl bg-[#1A1D26] hover:bg-red-950/60 border border-[#2D3342] text-[#949CAE] hover:text-red-300 flex items-center justify-center cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#13161E] border border-[#222733] text-xs font-medium text-[#949CAE] flex items-center justify-center gap-2">
                    <Clock className="w-3.5 h-3.5 shrink-0" />
                    <span>Indisponível (Em breve)</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
