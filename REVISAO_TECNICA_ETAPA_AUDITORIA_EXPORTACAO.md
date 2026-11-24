# Revisão técnica — exportação e preparação para DAW

## Escopo desta etapa
Auditoria do fluxo de exportação WAV, exportação individual de stems e criação do pacote ZIP no TRAP VANI AI.

## Verificações realizadas
- O WAV é escrito como RIFF/WAVE PCM inteiro, estéreo quando o render tem dois canais, com suporte a 16 e 24 bits.
- O cabeçalho WAV valida duração, tamanho RIFF e frequência de amostragem antes da alocação.
- Os stems individuais são renderizados a partir do segundo zero e usam a mesma duração de sessão, para facilitar alinhamento no DAW.
- A exportação forçada de uma pista respeita o mute dessa pista, mas não deixa que o estado solo de outra pista impeça a exportação escolhida.
- O ZIP usa STORE (sem compressão), nomes UTF-8, CRC-32 e diretório central; os conteúdos são adicionados como Blobs, sem montar um único ArrayBuffer gigante para o pacote.
- O limite estimado de 64 MB impede que a exportação em lote cresça sem controlo; o tamanho final também é verificado.
- O tempo de revogação dos URLs temporários de download foi aumentado para 60 segundos para dar mais margem a transferências em telemóveis.

## Testes executados
- Teste real do gerador ZIP com três entradas, incluindo nomes UTF-8: passou.
- `unzip -t` no pacote ZIP de teste: todos os ficheiros OK.
- Transpilação/sintaxe TypeScript e TSX: 17 ficheiros verificados, zero erros sintáticos.
- Integridade do ZIP completo do projeto: verificada após atualização.

## Limitações ainda abertas
- Não foi possível confirmar uma compilação Vite completa porque as dependências do projeto não estão instaladas neste ambiente.
- Não foi possível abrir o projeto num navegador Android nem importar os stems numa sessão real do BandLab.
- A qualidade sonora final, a latência, a carga de CPU e a memória durante renders longos ainda precisam de teste num aparelho real.
- O autotune atual é uma correção por análise de pitch e reamostragem granular; não implementa preservação independente de formantes e pode gerar artefactos em algumas vozes. Não deve ser apresentado como equivalente a um autotune profissional de estúdio.

## Estado
Esta etapa melhora a segurança do download e confirma a estrutura do ZIP de stems por teste independente. Não representa certificação completa do aplicativo nem substitui a compilação e os testes de áudio em dispositivo real.
