function ccjump -d "Jump to a Claude Code project"
    if test (count $argv) -gt 0; and test "$argv[1]" = "ls"
        command ccjump ls
        return
    end

    set -l project_path (command ccjump $argv)
    if test $status -eq 0 -a -n "$project_path" -a -d "$project_path"
        cd "$project_path"
        claude
    end
end
