import { LightningElement, api, wire, track } from 'lwc';
import { getRecord, getFieldValue, updateRecord } from 'lightning/uiRecordApi';
import { loadScript, loadStyle } from 'lightning/platformResourceLoader';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

import LEAFLET from '@salesforce/resourceUrl/leafletLib'; 

import ID_FIELD from '@salesforce/schema/Rotas__c.Id';
import LAT_LONG_FIELD from '@salesforce/schema/Rotas__c.Longitude_e_Latitude__c';
import CACHE_FIELD from '@salesforce/schema/Rotas__c.Cache_Geometria__c';

const FIELDS = [LAT_LONG_FIELD, CACHE_FIELD];
const OSRM_API = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';

export default class RotaMap extends LightningElement {
    @api recordId;

    @track isLoading = true;
    @track hasVisits = false; 
    @track statusMessage = 'Iniciando...';
    @track statusClass = 'slds-badge';

    map;
    leafletLoaded = false;
    mapInitialized = false;
    recordData;
    isUpdatingCache = false;
    
    routeLegs = []; 
    visitasOrdenadas = [];
    controlCalculadora = null;

    @wire(getRecord, { recordId: '$recordId', fields: FIELDS })
    wiredRecord({ error, data }) {
        if (data) {
            this.recordData = data;
            // CORREÇÃO DA REATIVIDADE:
            // Se o mapa já existe, forçamos o redesenho imediato.
            // Se não, segue o fluxo normal de inicialização.
            if (this.mapInitialized) {
                this.verificarEProcessarAtualizacao();
            } else {
                this.verificarDadosIniciais();
            }
        } else if (error) {
            console.error('Erro ao carregar registro:', error);
            this.showToast('Erro', 'Não foi possível carregar os dados.', 'error');
            this.isLoading = false;
            this.hasVisits = false;
        }
    }

    // Nova função para lidar com atualizações em tempo real
    verificarEProcessarAtualizacao() {
        const rawJson = getFieldValue(this.recordData, LAT_LONG_FIELD);
        if (!rawJson) {
            this.definirSemDados();
            return;
        }
        try {
            const visitas = JSON.parse(rawJson);
            if (!Array.isArray(visitas) || visitas.length === 0) {
                this.definirSemDados();
                return;
            }
            // Se chegou aqui, temos novos dados e o mapa já está na tela. Redesenha!
            this.hasVisits = true;
            this.processarRota(); 
        } catch (e) {
            this.definirSemDados();
        }
    }

    verificarDadosIniciais() {
        const rawJson = getFieldValue(this.recordData, LAT_LONG_FIELD);
        
        if (!rawJson) {
            this.definirSemDados();
            return;
        }

        try {
            const visitas = JSON.parse(rawJson);
            if (!Array.isArray(visitas) || visitas.length === 0) {
                this.definirSemDados();
                return;
            }
            this.hasVisits = true;
            if (this.leafletLoaded) {
                this.agendarInicializacaoMapa();
            }
        } catch (e) {
            console.warn('JSON inválido ou corrompido, ocultando mapa.');
            this.definirSemDados();
        }
    }

    definirSemDados() {
        this.hasVisits = false;
        this.isLoading = false;
        this.statusMessage = '';
    }

    renderedCallback() {
        if (this.leafletLoaded) {
            if (this.hasVisits && !this.mapInitialized) {
                this.agendarInicializacaoMapa();
            }
            return;
        }

        this.leafletLoaded = true;

        Promise.all([
            loadStyle(this, LEAFLET + '/dist/leaflet.css'),
            loadScript(this, LEAFLET + '/dist/leaflet.js')
        ])
        .then(() => {
            if (this.hasVisits) {
                this.agendarInicializacaoMapa();
            }
        })
        .catch(error => {
            this.showToast('Erro', 'Falha ao carregar biblioteca de mapa.', 'error');
            this.isLoading = false;
        });
    }

    agendarInicializacaoMapa() {
        Promise.resolve().then(() => {
            this.inicializarMapaBase();
        });
    }

    inicializarMapaBase() {
        if (this.mapInitialized) return;

        const mapDiv = this.template.querySelector('.map-root');
        if (!mapDiv) return;

        if (this.map) {
            this.map.remove();
            this.map = null;
        }

        mapDiv.style.height = '500px'; 
        mapDiv.style.width = '100%';
        // Define fundo cinza para camuflar tile gaps
        mapDiv.style.backgroundColor = '#ddd'; 

        // --- CORREÇÃO DAS LINHAS BRANCAS (Método CSS Injection) ---
        // Injeta estilo CSS específico para remover gaps entre tiles
        const style = document.createElement('style');
        style.innerText = `
            .leaflet-tile-container img {
                width: 256.5px !important;
                height: 256.5px !important;
                mix-blend-mode: normal !important;
                outline: 1px solid transparent; 
            }
        `;
        mapDiv.appendChild(style);

        if (window.L) {
            this.map = window.L.map(mapDiv, { zoomControl: true }).setView([-23.55, -46.63], 10);
            
            window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
                maxZoom: 19,
                attribution: '© OpenStreetMap'
            }).addTo(this.map);
            
            this.mapInitialized = true;
            this.processarRota();
        }
    }

    processarRota() {
        if (!this.recordData || !this.mapInitialized) return;
        
        this.isLoading = true;
        this.statusMessage = 'Calculando...';

        try {
            const rawJson = getFieldValue(this.recordData, LAT_LONG_FIELD);
            // IMPORTANTE: Para forçar atualização visual, ignoramos cache de tela se a assinatura mudar,
            // mas buscamos do campo Cache se disponível para economizar API.
            const rawCache = getFieldValue(this.recordData, CACHE_FIELD);
            const visitas = JSON.parse(rawJson);

            this.visitasOrdenadas = this.prepararVisitas(visitas);
            const assinaturaAtual = this.gerarAssinatura(this.visitasOrdenadas);
            
            let cacheValido = false;
            let geometry = null;
            let legs = [];

            if (rawCache) {
                try {
                    const cacheObj = JSON.parse(rawCache);
                    if (cacheObj.signature === assinaturaAtual && cacheObj.geometry) {
                        cacheValido = true;
                        geometry = cacheObj.geometry;
                        legs = cacheObj.legs || [];
                    }
                } catch(e) { console.warn('Cache invalido'); }
            }

            this.plotarMarcadoresNumerados(this.visitasOrdenadas);

            if (cacheValido) {
                this.atualizarStatus('Cache (Rápido)', 'success');
                this.desenharLinha(geometry);
                this.routeLegs = legs;
                this.adicionarPainelCalculadora();
                this.isLoading = false;
            } else {
                this.buscarNaApiOsrm(this.visitasOrdenadas, assinaturaAtual);
            }
        } catch (error) {
            console.error('Erro ao processar rota:', error);
            this.isLoading = false;
        }
    }

    prepararVisitas(visitas) {
        return [...visitas]
            .sort((a, b) => a.visita - b.visita)
            .map(v => {
                const lat = parseFloat(String(v.latitude).replace(',', '.'));
                const lng = parseFloat(String(v.longitude).replace(',', '.'));
                return { ...v, lat, lng, valido: (!isNaN(lat) && !isNaN(lng)) };
            });
    }

    gerarAssinatura(visitas) {
        return visitas.map(v => `${v.visita}:${v.lat},${v.lng}`).join('|');
    }

    async buscarNaApiOsrm(visitasSorted, assinatura) {
        this.atualizarStatus('Calculando rota...', 'warning');
        
        const validPoints = visitasSorted.filter(v => v.valido);

        if (validPoints.length < 2) {
            this.atualizarStatus('Pontos insuficientes', 'warning');
            this.isLoading = false;
            return;
        }

        const coords = validPoints.map(v => `${v.lng.toFixed(6)},${v.lat.toFixed(6)}`).join(';');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); 
        const url = `${OSRM_API}${coords}?overview=full&geometries=geojson`;

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) throw new Error(`Erro API: ${response.status}`);
            
            const data = await response.json();
            if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('Sem rota');

            const route = data.routes[0];
            const distKm = (route.distance / 1000).toFixed(1);

            this.desenharLinha(route.geometry);
            this.atualizarStatus(`Rota: ${distKm} km`, 'success');
            
            this.routeLegs = route.legs;
            this.adicionarPainelCalculadora();
            this.salvarCache(route.geometry, route.legs, assinatura);

        } catch (error) {
            console.error(error);
            this.atualizarStatus('Modo Offline', 'error');
            this.desenharLinhaRetaFallback(validPoints);
        } finally {
            this.isLoading = false;
        }
    }

    salvarCache(geometry, legs, assinatura) {
        // Verifica se realmente precisa salvar para evitar loop infinito de update
        const currentRawCache = getFieldValue(this.recordData, CACHE_FIELD);
        if (currentRawCache) {
             try {
                 const currentCache = JSON.parse(currentRawCache);
                 if (currentCache.signature === assinatura) return;
             } catch(e){}
        }

        this.isUpdatingCache = true;
        const fields = {};
        fields[ID_FIELD.fieldApiName] = this.recordId;
        fields[CACHE_FIELD.fieldApiName] = JSON.stringify({ signature: assinatura, geometry, legs });
        updateRecord({ fields }).then(() => { this.isUpdatingCache = false; }).catch(() => { this.isUpdatingCache = false; });
    }

    plotarMarcadoresNumerados(visitas) {
        if(!this.map || !window.L) return;
        this.limparCamadas(); 
        
        const group = window.L.featureGroup();
        const total = visitas.filter(v => v.valido).length;
        let count = 0;

        visitas.forEach((p) => {
            if (!p.valido) return;
            count++;
            let corFundo = '#0070d2'; 
            if (count === 1) corFundo = '#2e844a'; 
            else if (count === total) corFundo = '#ea001e';

            const iconHtml = `<div style="background-color:${corFundo};color:white;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-weight:bold;font-family:sans-serif;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);">${p.visita}</div>`;
            const customIcon = window.L.divIcon({ className: 'custom-pin', html: iconHtml, iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12] });

            window.L.marker([p.lat, p.lng], { icon: customIcon })
                .bindPopup(`<div style="text-align:center;"><strong style="color:${corFundo};">Visita ${p.visita}</strong><br/>${p.nome}</div>`)
                .addTo(group);
        });
        group.addTo(this.map);
        this.map.fitBounds(group.getBounds(), { padding: [50, 50] });
    }

    adicionarPainelCalculadora() {
        if (!window.L || !this.map || !this.routeLegs.length) return;
        if (this.controlCalculadora) this.map.removeControl(this.controlCalculadora);

        const self = this;
        const CalcControl = window.L.Control.extend({
            options: { position: 'topright' },
            onAdd: function() {
                const container = window.L.DomUtil.create('div', 'info legend');
                container.style.backgroundColor = 'white';
                container.style.padding = '8px 10px';
                container.style.borderRadius = '5px';
                container.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
                container.style.minWidth = '220px';

                const header = document.createElement('div');
                header.innerHTML = '<strong style="color:#0070d2; font-size:13px">📏 Calculadora</strong> <span style="float:right; cursor:pointer">▼</span>';
                container.appendChild(header);

                const content = document.createElement('div');
                content.style.marginTop = '5px';
                
                const selFrom = document.createElement('select'); selFrom.style.width = '100%'; selFrom.style.marginBottom='5px';
                const selTo = document.createElement('select'); selTo.style.width = '100%';
                
                const validos = self.visitasOrdenadas.filter(v => v.valido);
                validos.forEach((v, idx) => {
                    let nomeLimpo = v.nome.replace(/^\d+\s*[-.]\s*/, ''); 
                    if (nomeLimpo.length > 20) nomeLimpo = nomeLimpo.substring(0, 20) + '...';
                    const txt = `📍 ${v.visita} · ${nomeLimpo}`;
                    selFrom.add(new Option(txt, idx));
                    selTo.add(new Option(txt, idx));
                });
                selFrom.selectedIndex = 0; selTo.selectedIndex = validos.length - 1;
                
                const resultDiv = document.createElement('div');
                resultDiv.style.textAlign = 'center'; resultDiv.style.fontWeight = 'bold'; resultDiv.style.marginTop = '8px'; resultDiv.innerHTML = '---';

                content.append(selFrom, selTo, resultDiv);
                container.appendChild(content);

                let expanded = true;
                header.onclick = () => {
                    expanded = !expanded;
                    content.style.display = expanded ? 'block' : 'none';
                    container.style.width = expanded ? 'auto' : '130px';
                };

                const calc = () => {
                    const i1 = parseInt(selFrom.value), i2 = parseInt(selTo.value);
                    if(i1===i2) { resultDiv.innerHTML='0 km'; return; }
                    let m=0; for(let i=Math.min(i1,i2); i<Math.max(i1,i2); i++) if(self.routeLegs[i]) m+=self.routeLegs[i].distance;
                    resultDiv.innerHTML = (m/1000).toFixed(1) + ' km';
                    resultDiv.style.color = '#2e844a';
                };
                selFrom.onchange = selTo.onchange = calc;
                setTimeout(calc, 100);
                window.L.DomEvent.disableClickPropagation(container);
                return container;
            }
        });
        this.controlCalculadora = new CalcControl();
        this.map.addControl(this.controlCalculadora);
    }

    limparCamadas() {
        if(!this.map) return;
        this.map.eachLayer(layer => { if (!layer._url) this.map.removeLayer(layer); });
        if (this.controlCalculadora) { this.map.removeControl(this.controlCalculadora); this.controlCalculadora = null; }
    }

    desenharLinha(geometry) {
        if(!window.L) return;
        window.L.geoJSON(geometry, { style: { color: 'white', weight: 7, opacity: 0.8 } }).addTo(this.map);
        window.L.geoJSON(geometry, { style: { color: '#0070d2', weight: 5, opacity: 1 } }).addTo(this.map);
    }

    desenharLinhaRetaFallback(visitas) {
        if(window.L) {
            const pts = visitas.map(v => [v.lat, v.lng]);
            window.L.polyline(pts, { color: '#0070d2', weight: 4, opacity: 0.5, dashArray: '10, 10' }).addTo(this.map);
        }
    }

    atualizarStatus(msg, type) {
        this.statusMessage = msg;
        const color = type==='success'?'success':type==='warning'?'warning':type==='error'?'error':'inverse';
        this.statusClass = `slds-badge slds-theme_${color}`;
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}