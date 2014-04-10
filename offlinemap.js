var queue = require('queue-async');
var IDBStore = require('idb-wrapper');

OfflineLayer = L.TileLayer.extend({
    initialize: function (url, options) {
        L.TileLayer.prototype.initialize.call(this, url, options);

        this._onReady = options["onReady"];
        this._onError = options["onError"];
        var storeName = options["storeName"] || 'OfflineLeafletTileImages';

        this._hasBeenCanceled = false;
        this._nbTilesLeftToSave = 0;
        this._nbTilesWithError = 0;
        this._maxNbCachedZoomLevels = 10;

        this._tileImagesStore = new IDBStore({
            dbVersion: 1,
            storeName: storeName,
            keyPath: null,
            autoIncrement: false
        }, this._onReady);
    },

    _setUpTile: function (tile, key, value) {
        // Start loading the tile with either the cached tile image or the result of getTileUrl
        tile.src = value;
        this.fire('tileloadstart', {
            tile: tile,
            url: tile.src
        });
    },

    _loadTile: function (tile, tilePoint) {
        // Reproducing TileLayer._loadTile behavior, but the tile.src will be set later
        tile._layer = this;
        tile.onerror = this._tileOnError;
        this._adjustTilePoint(tilePoint);
        tile.onload = this._tileOnLoad;
        // Done reproducing _loadTile

        var self = this;
        var onSuccess = function(dbEntry){
            if(dbEntry){
                self._setUpTile(tile, key, dbEntry.image);
            }
            else{
                self._setUpTile(tile, key, self.getTileUrl(tilePoint));
            }
        }

        var onError = function() {
            // Error while getting the key from the DB
            self._setUpTile(tile, key, this.getTileUrl(tilePoint));
            if(self._onError){
                self._onError();
            }
        }

        var key = this._createTileKey(tilePoint.x, tilePoint.y, tilePoint.z);
        this._tileImagesStore.get(key, onSuccess, onError);
    },

    _updateTotalNbImagesLeftToSave: function(nbTiles){
        this._nbTilesLeftToSave = nbTiles;
        this.fire('tilecachingprogressstart', {nbTiles: this._nbTilesLeftToSave});
    },

    _decrementNbTilesLeftToSave: function(){
        this._nbTilesLeftToSave--;
        this.fire('tilecachingprogress', {nbTiles:this._nbTilesLeftToSave});
    },

    _incrementNbTilesWithError: function(){
        this._nbTilesWithError++;
    },

    cancel: function(){
        // no reason to cancel if it's not doing anything
        if(this._myQueue){
            this._hasBeenCanceled = true;
        }
    },

    clearTiles: function(){
        this._tileImagesStore.clear();
    },

    // calculateNbTiles includes potentially already saved tiles.
    calculateNbTiles: function(){
        var count = 0;
        var tileImagesToQuery = this._getTileImages();
        for(var key in tileImagesToQuery){
            console.log(key);
            count++;
        }
        console.log(count);
        return count;
    },

    isBusy: function(){
        return this._myQueue || this._hasBeenCanceled;
    },

    _getTileImages: function(){
        var tileImagesToQuery = {};

        var map = this._map;
        var startingZoom = map.getZoom();
        var maxZoom = map.getMaxZoom();

        var nbZoomLevelsToCache = maxZoom - startingZoom;
        if(nbZoomLevelsToCache > this._maxNbCachedZoomLevels){
            alert("Not possible to save more than " + this._maxNbCachedZoomLevels + " zoom levels.")
        }

        var bounds = map.getPixelBounds();
        var tileSize = this._getTileSize();

        var tileBounds = L.bounds(
            bounds.min.divideBy(tileSize)._floor(),
            bounds.max.divideBy(tileSize)._floor());

        var tilesInScreen = [];
        var j, i;

        for (j = tileBounds.min.y; j <= tileBounds.max.y; j++) {
            for (i = tileBounds.min.x; i <= tileBounds.max.x; i++) {
                tilesInScreen.push(new L.Point(i, j));
            }
        }

        var arrayLength = tilesInScreen.length;
        for (var i = 0; i < arrayLength; i++){
            var point = tilesInScreen[i];
            var x = point.x;
            var y = point.y;
            this._getZoomedInTiles(x, y, startingZoom, maxZoom, tileImagesToQuery);
            this._getZoomedOutTiles(Math.floor(x/2), Math.floor(y/2), startingZoom - 1, 0, tileImagesToQuery);
        }

        return tileImagesToQuery;
    },

    saveTiles: function(){
        if(this.isBusy()){
            alert("system is busy.");
            return;
        }

        this._hasBeenCanceled = false;

        var tileImagesToQuery = this._getTileImages();

        var tileImagesToQueryArray = [];
        for(var key in tileImagesToQuery){
            tileImagesToQueryArray.push(key);
        }

        var self = this;
        this._tileImagesStore.getBatch(tileImagesToQueryArray, function(items){
            self._myQueue = queue(8);
            var i = 0;
            self.fire('tilecachingstart', null);

            self._nbTilesLeftToSave = 0;
            items.forEach(function (item){
                if(item){
                    // image already exist
                }
                else{
                    var key = tileImagesToQueryArray[i];
                    var tileInfo = tileImagesToQuery[key];

                    self._nbTilesLeftToSave++;

                    var makingAjaxCall = function(url, callback, error, queueCallback){
                        self._ajax(url, callback, error, queueCallback);
                    }

                    var gettingImage = function (response) {
                        self._tileImagesStore.put(key, {"image": self._arrayBufferToBase64ImagePNG(response)});
                        self._decrementNbTilesLeftToSave();
                    }

                    var errorGettingImage = function (){
                        self._incrementNbTilesWithError();
                        self._decrementNbTilesLeftToSave();
                        if(this._onError){
                            this._onError();
                        }
                    };

                    self._myQueue.defer(makingAjaxCall, self._createURL(tileInfo.x, tileInfo.y, tileInfo.z),
                                        gettingImage, errorGettingImage);
                }

                i++;
            });

            self._updateTotalNbImagesLeftToSave(self._nbTilesLeftToSave);

            self._myQueue.awaitAll(function(error, data) {
                this._hasBeenCanceled = false;
                self._myQueue = null;
                self.fire('tilecachingprogressdone', null);
            });
        }, this._onBatchQueryError, 'dense');
    },

    _getZoomedInTiles: function(x, y, currentZ, maxZ, tileImagesToQuery){
        this._getTileImage(x, y, currentZ, tileImagesToQuery);

        if(currentZ < maxZ){
            // getting the 4 tile under the current tile
            this._getZoomedInTiles(x * 2, y * 2, currentZ + 1, maxZ, tileImagesToQuery);
            this._getZoomedInTiles(x * 2 + 1, y * 2, currentZ + 1, maxZ, tileImagesToQuery);
            this._getZoomedInTiles(x * 2, y * 2 + 1, currentZ + 1, maxZ, tileImagesToQuery);
            this._getZoomedInTiles(x * 2 + 1, y * 2 + 1, currentZ + 1, maxZ, tileImagesToQuery);
        }
    },

    _getZoomedOutTiles: function(x, y, currentZ, finalZ, tileImagesToQuery){
        this._getTileImage(x, y, currentZ, tileImagesToQuery);
        if(currentZ > finalZ){
            this._getZoomedOutTiles(Math.floor(x / 2), Math.floor(y / 2), currentZ - 1, finalZ, tileImagesToQuery);
        }
    },

    _getTileImage: function(x, y, z, tileImagesToQuery){
        // At this point, we only add the image to a "dictionary"
        // This is being done to avoid multiple requests when zooming out, since zooming int should never overlap
        var key = this._createTileKey(x, y, z);
        if(!tileImagesToQuery[key]){
            tileImagesToQuery[key] = {key:key, x: x, y: y, z: z};
        }
    },

    _onBatchQueryError: function(){
        if(this._onError){
            this._onError();
        }
    },

    _createURL: function(x, y, z){
        var subdomainIndex = Math.abs(x + y) % this.options.subdomains.length;
        var subdomain = this.options.subdomains[subdomainIndex];
        return L.Util.template(mapquestUrl,
            L.extend({
                s: subdomain,
                z: z,
                x: x,
                y: y
            }, this.options));
    },

    // TAKEN FROM OfflineMap
    /*
     Probably btoa can work incorrect, you can override btoa with next example:
     https://developer.mozilla.org/en-US/docs/Web/JavaScript/Base64_encoding_and_decoding#Solution_.232_.E2.80.93_rewriting_atob%28%29_and_btoa%28%29_using_TypedArrays_and_UTF-8
     */
    _arrayBufferToBase64ImagePNG: function(buffer) {
        var binary = '';
        var bytes = new Uint8Array(buffer);
        for (var i = 0, l = bytes.byteLength; i < l; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return 'data:image/png;base64,' + btoa(binary);
    },

    _createTileKey: function(x, y, z){
        return x + ", " + y + ", " + z;
    },

    // TAKEN FROM OfflineMap
    _ajax: function(url, callback, error, queueCallback) {
        if(this._hasBeenCanceled){
            queueCallback();
            return;
        }

        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function(err) {
            if (this.status == 200) {
                callback(this.response);
            }
            else{
                error();
            }
            queueCallback();
        };
        xhr.send();
    }
});

OfflineProgressControl = L.Control.extend({
    options: {
        position: 'topright'
    },

    onAdd: function (map) {
        var controls = L.DomUtil.create('div', 'offlinemap-controls', this._container);

        this._counter = L.DomUtil.create('div', 'offlinemap-controls-counter', controls);
        this._counter.innerHTML = "0";

        var cancelButton = L.DomUtil.create('input', 'offlinemap-controls-cancel-button', controls);
        cancelButton.setAttribute('type', "button");
        cancelButton.setAttribute('id', "cancelBtn");
        cancelButton.setAttribute('value', "Cancel");

        L.DomEvent.addListener(cancelButton, 'click', this.onCancelClick, this);
        L.DomEvent.disableClickPropagation(cancelButton);

        return controls;
    },

    onProgressStart: function(){
        // Tiles will get downloaded and probably cached while we are still looking at the result from the DB
        // To avoid any weird display, we set _evaluating to false and display nothing until the total nb tiles
        // is known.
        this._evaluating = true;
        this._counter.innerHTML = "...";
    },

    onProgressDone: function(){

    },

    updateTotalNbTilesLeftToSave: function (event){
        this._evaluating = false;
        this._nbTilesToSave = event.nbTiles;
        this.updateNbTilesLeftToSave(event.nbTiles);
    },

    updateNbTilesLeftToSave: function (event){
        if(!this._evaluating){
            if(this._nbTilesToSave == 0){
                this._counter.innerHTML = "100%";
            }
            else{
                this._counter.innerHTML = Math.floor((this._nbTilesToSave - event.nbTiles) / this._nbTilesToSave * 100) + "%";
            }
        }
    },

    onCancelClick: function (){
        this._offlineLayer.cancel();
    },

    setOfflineLayer: function (offlineLayer){
        this._offlineLayer = offlineLayer;
        this._offlineLayer.on('tilecachingstart', this.onProgressStart, this);
        this._offlineLayer.on('tilecachingprogressstart', this.updateTotalNbTilesLeftToSave, this);
        this._offlineLayer.on('tilecachingprogress', this.updateNbTilesLeftToSave, this);
        this._offlineLayer.on('tilecachingprogressdone', this.onProgressDone, this);

    }
});