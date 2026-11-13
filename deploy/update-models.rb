# Merge the bundled CPA rules into an existing installation. Run from its directory.
require "yaml"
require "tempfile"
require "fileutils"

def mapping(parent, *keys)
  keys.reduce(parent) { |obj, key| obj[key] ||= {} }
end

def merge_models(config)
  aliases = mapping(config, "oauth", "model-alias")["antigravity"] ||= []
  payload = mapping(config, "requests", "payload")
  prefix = "generationConfig.thinkingConfig."
  {"hydrogen" => "xhigh", "carbon" => "high"}.each do |family, top|
    base = "gemini-4-#{family}"
    (["", "low", "medium", "high", top].uniq).each do |level|
      id = [base, level].reject(&:empty?).join("-")
      unless level == top || aliases.any? { |a| a["alias"] == id }
        aliases << {"name" => "#{base}-#{top}", "alias" => id, "fork" => true}
      end
      model = {"name" => id, "protocol" => "antigravity"}
      rules = if level.empty?
        model["not-exist"] = ["generationConfig.thinkingConfig"]
        {"default" => {prefix+"thinkingBudget" => -1, prefix+"includeThoughts" => true}}
      else
        {"override" => {prefix+"thinkingLevel" => level, prefix+"includeThoughts" => true},
         "filter" => [prefix+"thinkingBudget"]}
      end
      rules.each do |kind, params|
        list = payload[kind] ||= []
        existing = list.select { |r| Array(r["models"]).any? { |m| m["name"] == id && ["antigravity", nil, ""].include?(m["protocol"]) } }
        covered = existing.flat_map { |r| r["params"].is_a?(Hash) ? r["params"].keys : Array(r["params"]) }
        missing = params.is_a?(Hash) ? params.reject { |k,_| covered.include?(k) } : params - covered
        list << {"models" => [model], "params" => missing} unless missing.empty?
      end
    end
  end
end

def stage(path, obj)
  file = Tempfile.create([".agy-update-", ".tmp"], File.dirname(path))
  begin
    file.write(YAML.dump(obj)); file.flush; file.fsync
    stat = File.stat(path)
    file.chown(stat.uid, stat.gid) if Process.euid.zero?
    file.chmod(stat.mode & 0777)
  ensure
    file.close
  end
  file.path
end

def load_yaml(path)
  YAML.safe_load(File.read(path), aliases: true)
end

File.open(".agy-model-update.lock", "a", 0600) do |lock|
  lock.flock(File::LOCK_EX)
  paths = ["cpa/config.yaml", "docker-compose.yml"]
  config, compose = paths.map { |path| load_yaml(path) }
  originals = [config, compose].map { |obj| Marshal.dump(obj) }
  merge_models(config)
  catalog = mapping(config, "models")
  managed = [nil, "/CLIProxyAPI/catalog/models.json"].include?(catalog["catalog"])
  if managed
    catalog["catalog"] = "/CLIProxyAPI/catalog/models.json"
    {"cpa" => "/CLIProxyAPI/catalog", "agy-me" => "/app/catalog"}.each do |svc, target|
      volumes = compose.fetch("services").fetch(svc)["volumes"] ||= []
      match = volumes.find { |v| (v.is_a?(Hash) ? v["target"] : v.split(":")[1]) == target }
      if match
        source = match.is_a?(Hash) ? match["source"] : match.split(":")[0]
        abort "自定义目录挂载 #{target}，请手动核对后再更新。" unless File.expand_path(source) == File.expand_path("cpa/catalog")
      else
        volumes << "./cpa/catalog:#{target}" + (svc == "cpa" ? ":ro" : "")
      end
    end
  end
  edits = {}
  [config, compose].each_with_index do |obj, i|
    edits[paths[i]] = stage(paths[i], obj) unless Marshal.dump(obj) == originals[i]
  end
  stamp = Time.now.strftime("%Y%m%d-%H%M%S") + "-#{Process.pid}"
  edits.each_key { |path| FileUtils.cp(path, path+".bak-"+stamp, preserve: true) }
  edits.each { |path, tmp| File.rename(tmp, path) }
  puts edits.empty? ? "模型配置已是最新。" : "已补齐模型配置，原文件备份后缀为 .bak-#{stamp}。"
end
