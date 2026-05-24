# Salesforce Maps — Roteirização de Visitas

Lightning Web Component (LWC) que calcula e exibe, dentro do próprio Salesforce, a rota de um roteiro de visitas em um mapa interativo.

A partir de uma lista de visitas (com latitude/longitude) salva em um registro, o componente desenha o trajeto de carro entre os pontos na ordem definida, plota cada parada e calcula a distância da rota.

## Tecnologias

- Salesforce Lightning Web Components (LWC)
- JavaScript
- Leaflet.js + OpenStreetMap (renderização do mapa)
- OSRM (API de roteirização)

## Funcionalidades

- Traça a rota de carro entre múltiplas paradas usando a API OSRM
- Marcadores numerados, com a origem em verde e o destino em vermelho
- Calculadora de distância entre quaisquer dois pontos do roteiro
- Cache da geometria da rota, para evitar recalcular e economizar chamadas de API
- Modo de fallback (linha reta) quando a API está indisponível
- Atualização reativa: o mapa se redesenha automaticamente quando os dados do registro mudam

## Como funciona

O componente lê de um campo do registro (`Longitude_e_Latitude__c`) um JSON com as visitas — latitude, longitude e ordem — calcula a rota via OSRM e a desenha com Leaflet.

Para não chamar a API toda vez que o mapa abre, a geometria calculada é guardada em um campo de cache (`Cache_Geometria__c`) junto com uma "assinatura" do roteiro. Se o roteiro não mudou, o componente reaproveita o cache em vez de recalcular.

## Pré-requisitos para rodar

- Uma org Salesforce com o objeto customizado de roteiros (`Rotas__c`), contendo os campos de coordenadas (JSON) e de cache
- A biblioteca Leaflet adicionada como **Static Resource** (`leafletLib`)
- Deploy via Salesforce CLI:

```bash
sf project deploy start
```

## Autor

**Thalisson Pereira**
[LinkedIn](https://www.linkedin.com/in/thalissonpereira2003) · [GitHub](https://github.com/ThalissonS)
