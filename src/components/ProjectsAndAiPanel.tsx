import React, { useRef, useState } from 'react';
import {
  Disc3,
  Download,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Send,
  Trash2,
  Upload,
} from 'lucide-react';
import { ChatMessage, TrapProject } from '../types/studio';

interface ProjectsAndAiPanelProps {
  projects: TrapProject[];
  activeProject: TrapProject;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onRenameProject: (name: string) => void;
  onDeleteProject: (id: string) => void;
  onUpdateCoverArt: (dataUrl: string | null) => void;
  onSendChat: (text: string, fastMode: boolean) => Promise<void>;
  onExportBackup: () => Promise<Blob>;
  onImportBackup: (file: File) => Promise<void>;
}

export const ProjectsAndAiPanel: React.FC<ProjectsAndAiPanelProps> = ({
  projects,
  activeProject,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onUpdateCoverArt,
  onSendChat,
  onExportBackup,
  onImportBackup,
}) => {
  const [renameText, setRenameText] = useState(activeProject.name);
  const [coverPrompt, setCoverPrompt] = useState('');
  const [coverSize, setCoverSize] = useState<'1K' | '2K' | '4K'>('1K');
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState('');
  const [fastMode, setFastMode] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const backupInputRef = useRef<HTMLInputElement | null>(null);

  const coverUploadRef = useRef<HTMLInputElement | null>(null);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);

  const handleGenerateCover = async () => {
    if (!coverPrompt.trim()) return;
    setCoverError(null);
    setCoverBusy(true);
    try {
      const res = await fetch('/api/ai/cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: coverPrompt.trim(), imageSize: coverSize }),
      });
      const data = (await res.json()) as { imageUrl?: string; error?: string };
      if (!res.ok || !data.imageUrl) {
        throw new Error(data.error || 'Erro ao gerar capa.');
      }
      onUpdateCoverArt(data.imageUrl);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : 'Falha na geração da capa.');
    } finally {
      setCoverBusy(false);
    }
  };

  const handleUploadCover = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onUpdateCoverArt(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSubmitChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatBusy) return;
    const text = chatInput.trim();
    setChatInput('');
    setChatError(null);
    setChatBusy(true);
    try {
      await onSendChat(text, fastMode);
      setTimeout(() => {
        chatThreadRef.current?.scrollTo({
          top: chatThreadRef.current.scrollHeight,
          behavior: 'smooth',
        });
      }, 60);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Erro ao falar com o produtor IA.');
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* 1. Local Studio Projects Organizer */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
              Projetos do Estúdio
            </h3>
            <p className="text-xs sm:text-sm text-[#949CAE] mt-0.5">
              Todas as gravações, beats e misturas são guardadas localmente no dispositivo.
            </p>
          </div>
          <button
            type="button"
            onClick={onCreateProject}
            className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-[#0A0B0E] font-semibold text-sm flex items-center gap-2 cursor-pointer whitespace-nowrap"
          >
            <FolderPlus className="w-4 h-4" />
            <span>Novo Projeto</span>
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={backupBusy}
            onClick={async () => {
              setBackupBusy(true); setBackupError(null);
              try {
                const blob = await onExportBackup();
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `trap-vani-${activeProject.name.replace(/[^a-z0-9-_]/gi, '_').slice(0, 40)}.tvbackup.json`;
                document.body.appendChild(link); link.click(); link.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 1500);
              } catch (error) {
                setBackupError(error instanceof Error ? error.message : 'Não foi possível criar a cópia.');
              } finally { setBackupBusy(false); }
            }}
            className="min-h-[44px] px-3 rounded-xl bg-[#1A1D26] border border-[#2D3342] text-sm text-[#E2E6EE] flex items-center gap-2 disabled:opacity-50"
          >
            <Download className="w-4 h-4" /> Guardar cópia deste projeto
          </button>
          <button
            type="button"
            disabled={backupBusy}
            onClick={() => backupInputRef.current?.click()}
            className="min-h-[44px] px-3 rounded-xl bg-[#1A1D26] border border-[#2D3342] text-sm text-[#E2E6EE] flex items-center gap-2 disabled:opacity-50"
          >
            <Upload className="w-4 h-4" /> Restaurar cópia
          </button>
          <input ref={backupInputRef} type="file" accept=".json,.tvbackup.json,application/json" className="hidden" onChange={async (event) => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file) return;
            setBackupBusy(true); setBackupError(null);
            try { await onImportBackup(file); }
            catch (error) { setBackupError(error instanceof Error ? error.message : 'Não foi possível restaurar a cópia.'); }
            finally { setBackupBusy(false); }
          }} />
        </div>
        {backupBusy && <p className="text-xs text-amber-300">A preparar a cópia de segurança...</p>}
        {backupError && <p role="alert" className="text-xs text-red-300">{backupError}</p>}

        {/* Rename Active Project */}
        <div className="flex gap-2">
          <input
            type="text"
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onBlur={() => {
              if (renameText.trim()) onRenameProject(renameText.trim());
            }}
            placeholder="Nome do projeto"
            className="flex-1 min-h-[44px] bg-[#0D0F14] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
          />
          <button
            type="button"
            onClick={() => {
              if (renameText.trim()) onRenameProject(renameText.trim());
            }}
            className="min-h-[44px] px-4 py-2 rounded-xl bg-[#1A1D26] hover:bg-[#232734] border border-[#2D3342] text-xs font-semibold text-[#E2E6EE] cursor-pointer"
          >
            Renomear
          </button>
        </div>

        {/* Project List */}
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {projects.map((p) => {
            const isActive = p.id === activeProject.id;
            return (
              <div
                key={p.id}
                className={`flex items-center justify-between gap-3 p-3 rounded-xl border transition-colors ${
                  isActive
                    ? 'bg-[#191C24] border-amber-500/70'
                    : 'bg-[#0D0F14] border-[#222733] hover:border-[#32394A]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectProject(p.id);
                    setRenameText(p.name);
                  }}
                  className="flex-1 text-left min-w-0 cursor-pointer"
                >
                  <div className="text-sm font-semibold text-[#F4F4F6] truncate">{p.name}</div>
                  <div className="text-xs text-[#949CAE] font-mono-tabular mt-0.5">
                    {p.bpm} BPM · {p.key} {p.scale.replace('_', ' ')} ·{' '}
                    {p.vocalDurationSec > 0
                      ? `Voz ${p.vocalDurationSec.toFixed(1)}s`
                      : 'Sem voz gravada'}
                  </div>
                </button>

                {projects.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onDeleteProject(p.id)}
                    aria-label="Apagar projeto"
                    className="min-h-[40px] min-w-[40px] rounded-lg bg-[#1A1D26] hover:bg-red-950/60 text-[#949CAE] hover:text-red-300 flex items-center justify-center cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Single Cover Art (1K / 2K / 4K + Upload) */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-amber-400" />
          <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
            Capa do Single (1K / 2K / 4K)
          </h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-4 items-start">
          <div className="w-40 h-40 rounded-xl bg-[#0D0F14] border border-[#252A36] overflow-hidden flex items-center justify-center shrink-0 mx-auto md:mx-0">
            {activeProject.coverArtDataUrl ? (
              <img
                src={activeProject.coverArtDataUrl}
                alt={`Capa do projeto ${activeProject.name}`}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="text-center p-3 space-y-1.5">
                <Disc3 className="w-8 h-8 text-[#464E61] mx-auto" />
                <div className="text-[11px] text-[#6B7385]">Sem capa ainda</div>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <input
              type="text"
              value={coverPrompt}
              onChange={(e) => setCoverPrompt(e.target.value)}
              placeholder="Descreva a capa (ex: carro desportivo à chuva numa noite sombria em Lisboa)"
              className="w-full min-h-[44px] bg-[#0D0F14] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
            />

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[#949CAE]">Resolução:</span>
              {(['1K', '2K', '4K'] as const).map((sz) => (
                <button
                  key={sz}
                  type="button"
                  onClick={() => setCoverSize(sz)}
                  className={`min-h-[38px] px-3 rounded-lg text-xs font-mono-tabular font-semibold cursor-pointer ${
                    coverSize === sz
                      ? 'bg-amber-500 text-[#0A0B0E]'
                      : 'bg-[#0D0F14] border border-[#252A36] text-[#CBD2DF]'
                  }`}
                >
                  {sz}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                disabled={coverBusy || !coverPrompt.trim()}
                onClick={handleGenerateCover}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-[#0A0B0E] font-semibold text-sm flex items-center gap-2 cursor-pointer"
              >
                {coverBusy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ImageIcon className="w-4 h-4" />
                )}
                <span>Gerar Capa ({coverSize})</span>
              </button>

              <input
                ref={coverUploadRef}
                type="file"
                accept="image/*"
                onChange={handleUploadCover}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => coverUploadRef.current?.click()}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-[#1A1D26] hover:bg-[#232734] border border-[#2D3342] text-sm text-[#E2E6EE] flex items-center gap-2 cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                <span>Carregar Imagem</span>
              </button>
            </div>

            {coverError && (
              <div className="text-xs text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
                {coverError}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. Multi-turn Trap Producer Assistant Chatbot */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-amber-400" />
            <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
              Assistente Produtor de Estúdio
            </h3>
          </div>

          <button
            type="button"
            onClick={() => setFastMode((v) => !v)}
            className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer ${
              fastMode
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'bg-[#0D0F14] text-[#949CAE] border border-[#252A36]'
            }`}
          >
            {fastMode ? 'Modo Rápido (Baixa Latência)' : 'Modo Produtor Completo'}
          </button>
        </div>

        <div
          ref={chatThreadRef}
          className="h-64 overflow-y-auto bg-[#0D0F14] border border-[#222733] rounded-xl p-3 space-y-3"
        >
          {activeProject.chatHistory.map((m: ChatMessage) => (
            <div
              key={m.id}
              className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-amber-500 text-[#0A0B0E] font-medium'
                    : 'bg-[#181B23] border border-[#272D3B] text-[#E2E6EE]'
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
          {chatBusy && (
            <div className="flex items-center gap-2 text-xs text-[#949CAE]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>A pensar na melhor dica de produção...</span>
            </div>
          )}
        </div>

        {chatError && (
          <div className="text-xs text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
            {chatError}
          </div>
        )}

        <form onSubmit={handleSubmitChat} className="flex gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Pergunte sobre mistura, 808, afinação ou estrutura..."
            className="flex-1 min-h-[46px] bg-[#0D0F14] border border-[#252A36] focus:border-amber-500 outline-none rounded-xl px-3.5 text-sm text-[#F4F4F6]"
          />
          <button
            type="submit"
            disabled={chatBusy || !chatInput.trim()}
            className="min-h-[46px] min-w-[46px] px-4 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-[#0A0B0E] font-semibold flex items-center justify-center cursor-pointer"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
};
